export function stripTestPlanFromPRBody(body: string): string {
    const startDelimiter = '<!--';
    const endDelimiter = '-->';
  
    let startIndex = body.indexOf(startDelimiter);
    if (startIndex === -1) {
      return body; 
    }
  
    let endIndex = body.indexOf(endDelimiter, startIndex + startDelimiter.length);
    if (endIndex === -1) {
      return body;
    }
  
    return body.slice(0, startIndex) + body.slice(endIndex + endDelimiter.length); 
};
