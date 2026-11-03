// sql.js single-file build with the WebAssembly module inlined (web database).
declare module 'sql.js/dist/sql-wasm-inline.js' {
  import initSqlJs from 'sql.js';
  export default initSqlJs;
}
