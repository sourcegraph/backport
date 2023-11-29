export const stripTestPlanFromPRBody = (body: string): string => {
  return body.replace(/<!--[\s\S]*?-->/g, "");
}
