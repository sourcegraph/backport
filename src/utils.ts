export function stripTestPlanFromPRBody(body: string): string {
    return body.replace(/<!--[\s\S]*?-->/g, ''); 
};
