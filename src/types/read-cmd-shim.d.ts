declare module 'read-cmd-shim' {
  function readCmdShim(path: string): Promise<string>;
  export default readCmdShim;
}
