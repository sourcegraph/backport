import { getInput, setFailed, setOutput } from "@actions/core";
import { context } from "@actions/github";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import ensureError from "ensure-error";
import { template } from "lodash-es";
import { backport } from "./backport.js";

const run = async () => {
  try {
    const [getBody, getHead, getTitle] = [
      "body_template",
      "head_template",
      "title_template",
    ].map((name) => template(getInput(name)));

    const labelPattern = getInput("label_pattern");
    const labelRegExp = new RegExp(labelPattern);

    const token = getInput("github_token", { required: true });

    if (!context.payload.pull_request) {
      throw new Error(`Unsupported event action: ${context.payload.action}.`);
    }

    const payload = context.payload as PullRequestEvent;

    if (payload.action !== "closed" && payload.action !== "labeled") {
      throw new Error(
        `Unsupported pull request event action: ${payload.action}.`,
      );
    }

    const createdPullRequestBaseBranchToNumber = await backport({
      getBody,
      getHead,
      getTitle,
      labelRegExp,
      payload,
      token,
    });
    setOutput(
      "created_pull_requests",
      JSON.stringify(createdPullRequestBaseBranchToNumber),
    );
  } catch (_error: unknown) {
    const error = ensureError(_error);
    setFailed(error);
  }
};

void run();
