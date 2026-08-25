// action-demo handler.js — demo.hello 的 client action 处理器。
//
// 由桌面壳 registerClientActionsForPlugin 经 read_plugin_file('handler.js') 取出，
// 注入 sandbox iframe 以 ES module 执行；导出名与 manifest actions[].handler.export 对齐（default）。
// executeClientActionAdapter 要求 exportName 指向一个 `(input) => result` 的（可异步）函数，
// result 必须是 JSON 对象（否则回 action_output_invalid）。
export default async function demoHello(input) {
  const name = (input && typeof input.name === 'string' && input.name.trim()) || 'world';
  return { greeting: `hello ${name}` };
}
