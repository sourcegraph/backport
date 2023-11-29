export const stripTestPlanFromPRBody = (body: string): string =>
  body.replace(/<!--[\s\S]*?-->/g, "");
