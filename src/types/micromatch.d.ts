declare module 'micromatch' {
  interface Micromatch {
    (
      list: readonly string[],
      patterns: readonly string[],
    ): string[];
    isMatch(input: string, patterns: readonly string[]): boolean;
  }

  const micromatch: Micromatch;
  export default micromatch;
}
