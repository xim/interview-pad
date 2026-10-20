// The "> command" lines in the output pane (styled like binji/wasm-clang's terminal).
const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);
export const echo = (command: string[]) => `\x1b[1;93m>\x1b[0m ${command.map(quote).join(' ')}\n`;
