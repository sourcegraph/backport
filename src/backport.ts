import { group, info, error as logError, warning } from "@actions/core";
import { exec } from "@actions/exec";
import { getOctokit } from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils.js";
import type {
  PullRequestClosedEvent,
  PullRequestLabeledEvent,
} from "@octokit/webhooks-types";
import ensureError from "ensure-error";
import { compact } from "lodash-es";

const getBaseBranchFromLabel = (
  label: string,
  labelRegExp: RegExp,
): string | undefined => {
  const result = labelRegExp.exec(label);

  if (!result || !result.groups) {
    return;
  }

  const { base } = result.groups;

  if (!base) {
    throw new Error(
      `RegExp "${String(
        labelRegExp,
      )}" matched "${label}" but missed a "base" named capturing group.`,
    );
  }

  return base;
};

const getBaseBranches = ({
  labelRegExp,
  payload,
}: Readonly<{
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
}>): string[] => {
  if ("label" in payload) {
    const base = getBaseBranchFromLabel(payload.label.name, labelRegExp);
    return base ? [base] : [];
  }

  return compact(
    payload.pull_request.labels.map((label) =>
      getBaseBranchFromLabel(label.name, labelRegExp),
    ),
  );
};

const warnIfSquashIsNotTheOnlyAllowedMergeMethod = async ({
  github,
  owner,
  repo,
}: {
  github: InstanceType<typeof GitHub>;
  owner: string;
  repo: string;
}) => {
  const {
    data: { allow_merge_commit, allow_rebase_merge },
  } = await github.request("GET /repos/{owner}/{repo}", { owner, repo });
  if (allow_merge_commit || allow_rebase_merge) {
    warning(
      [
        "Your repository allows merge commits and rebase merging.",
        " However, Backport only supports rebased and merged pull requests with a single commit and squashed and merged pull requests.",
        " Consider only allowing squash merging.",
        " See https://help.github.com/en/github/administering-a-repository/about-merge-methods-on-github for more information.",
      ].join("\n"),
    );
  }
};

const backportOnce = async ({
  author,
  base,
  body,
  commitSha,
  github,
  head,
  labels,
  merged_by,
  owner,
  repo,
  title,
}: Readonly<{
  author: string;
  base: string;
  body: string;
  commitSha: string;
  github: InstanceType<typeof GitHub>;
  head: string;
  labels: readonly string[];
  merged_by: string;
  owner: string;
  repo: string;
  title: string;
}>): Promise<number> => {
  const git = async (...args: string[]) => {
    await exec("git", args, { cwd: repo });
  };

  await git("switch", base);
  await git("switch", "--create", head);
  try {
    await git("cherry-pick", "-x", commitSha);
  } catch (error: unknown) {
    await git("cherry-pick", "--abort");
    throw error;
  }

  await git("push", "--set-upstream", "origin", head);
  const {
    data: { number },
  } = await github.request("POST /repos/{owner}/{repo}/pulls", {
    base,
    body,
    head,
    owner,
    repo,
    title,
  });
  await github.request(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
    {
      owner,
      pull_number: number,
      repo,
      reviewers:
        author !== merged_by && merged_by !== ""
          ? [author, merged_by]
          : [author],
      team_reviewers: ["release-guild"],
    },
  );
  if (labels.length > 0) {
    await github.request(
      "PUT /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        issue_number: number,
        labels: [...labels],
        owner,
        repo,
      },
    );
  }

  info(`PR #${number} has been created.`);
  return number;
};

const getFailedBackportCommentBody = ({
  base,
  commitSha,
  errorMessage,
  head,
  runUrl,
}: {
  base: string;
  commitSha: string;
  errorMessage: string;
  head: string;
  runUrl: string;
}) => {
  const worktreePath = `.worktrees/backport-${base}`;
  return [
    `The backport to \`${base}\` failed:`,
    "```",
    errorMessage,
    "```",
    "To backport manually, run these commands in your terminal:",
    "```bash",
    "# Fetch latest updates from GitHub",
    "git fetch",
    "# Create a new working tree",
    `git worktree add ${worktreePath} ${base}`,
    "# Navigate to the new working tree",
    `cd ${worktreePath}`,
    "# Create a new branch",
    `git switch --create ${head}`,
    "# Cherry-pick the merged commit of this pull request and resolve the conflicts",
    `git cherry-pick -x --mainline 1 ${commitSha}`,
    "# Push it to GitHub",
    `git push --set-upstream origin ${head}`,
    "# Go back to the original working tree",
    "cd ../..",
    "# Delete the working tree",
    `git worktree remove ${worktreePath}`,
    "```",
    `Then, create a pull request where the \`base\` branch is \`${base}\` and the \`compare\`/\`head\` branch is \`${head}\`.`,
    `See ${runUrl} for more information.`,
    "Make sure to tag `@sourcegraph/release-guild` in the pull request description.",
    "Once the backport pull request is created, kindly remove the `release-blocker` from this pull request."
  ].join("\n");
};

const backport = async ({
  getBody,
  getHead,
  getTitle,
  labelRegExp,
  payload,
  runId,
  runNumber,
  serverUrl,
  token,
}: {
  getBody: (
    props: Readonly<{
      base: string;
      body: string;
      mergeCommitSha: string;
      number: number;
    }>,
  ) => string;
  getHead: (
    props: Readonly<{
      base: string;
      number: number;
    }>,
  ) => string;
  getTitle: (
    props: Readonly<{
      base: string;
      number: number;
      title: string;
    }>,
  ) => string;
  labelRegExp: RegExp;
  payload: PullRequestClosedEvent | PullRequestLabeledEvent;
  runId: number;
  runNumber: number;
  serverUrl: string;
  token: string;
}): Promise<{ [base: string]: number }> => {
  const {
    pull_request: {
      body: originalBody,
      labels: originalLabels,
      merge_commit_sha: mergeCommitSha,
      merged,
      merged_by: originalMergedBy,
      number,
      title: originalTitle,
      user: { login: author },
    },
    repository: {
      name: repo,
      owner: { login: owner },
    },
  } = payload;

  if (merged !== true || !mergeCommitSha) {
    // See https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#pull_request_target.
    throw new Error(
      "For security reasons, this action should only run on merged PRs.",
    );
  }

  const baseBranches = getBaseBranches({ labelRegExp, payload });
  if (baseBranches.length === 0) {
    info("No backports required.");
    return {};
  }

  const github = getOctokit(token);

  await warnIfSquashIsNotTheOnlyAllowedMergeMethod({ github, owner, repo });

  info(`Backporting ${mergeCommitSha} from #${number}.`);

  const cloneUrl = new URL(payload.repository.clone_url);
  cloneUrl.username = "x-access-token";
  cloneUrl.password = token;

  await exec("git", ["clone", cloneUrl.toString()]);
  await exec("git", [
    "config",
    "--global",
    "user.email",
    "github-actions[bot]@users.noreply.github.com",
  ]);
  await exec("git", ["config", "--global", "user.name", "github-actions[bot]"]);

  const createdPullRequestBaseBranchToNumber: { [base: string]: number } = {};

  for (const base of baseBranches) {
    const body = getBody({
      base,
      body: originalBody ?? "",
      mergeCommitSha,
      number,
    });
    const head = getHead({ base, number });
    const labels = originalLabels
      .map((label) => label.name)
      .filter((label) => !labelRegExp.test(label));
    labels.push("backports", `backported-to-${base}`);

    const title = getTitle({ base, number, title: originalTitle });
    const merged_by = originalMergedBy?.login ?? "";
    const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${runId}/jobs/${runNumber}`;
    // PRs are handled sequentially to avoid breaking GitHub's log grouping feature.
    // eslint-disable-next-line no-await-in-loop
    await group(`Backporting to ${base} on ${head}.`, async () => {
      try {
        const backportPullRequestNumber = await backportOnce({
          author,
          base,
          body,
          commitSha: mergeCommitSha,
          github,
          head,
          labels,
          merged_by,
          owner,
          repo,
          title,
        });
        createdPullRequestBaseBranchToNumber[base] = backportPullRequestNumber;
      } catch (_error: unknown) {
        const error = ensureError(_error);
        logError(error);

        await github.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            body: getFailedBackportCommentBody({
              base,
              commitSha: mergeCommitSha,
              errorMessage: error.message,
              head,
              runUrl,
            }),
            issue_number: number,
            owner,
            repo,
          },
        );

        await github.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
          {
            issue_number: number,
            labels: [
              "backports",
              "release-blocker",
              `failed-backport-to-${base}`,
            ],
            owner,
            repo,
          },
        );
      }
    });
  }

  return createdPullRequestBaseBranchToNumber;
};

export { backport };
