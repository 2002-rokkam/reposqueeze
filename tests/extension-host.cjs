const assert = require('node:assert/strict');
const vscode = require('vscode');
exports.run = async function () {
  const extension=vscode.extensions.getExtension('2002-rokkam.reposqueeze-v2');
  assert(extension,'extension is installed in host');
  await extension.activate();assert(extension.isActive);
  const names=vscode.lm.tools.map(t=>t.name);
  assert(names.includes('reposqueeze_v2_context'));assert(names.includes('reposqueeze_v2_expand'));
  const result=await vscode.lm.invokeTool('reposqueeze_v2_context',{input:{query:'contextPack budget',budget:1000},toolInvocationToken:undefined});
  const text=result.content.filter(c=>c instanceof vscode.LanguageModelTextPart).map(c=>c.value).join('\n');
  assert(text.includes('REPOSQUEEZE'));assert(text.includes('src/context.ts'));
  const expanded=await vscode.lm.invokeTool('reposqueeze_v2_expand',{input:{path:'src/tokens.ts',start:1,end:3,budget:1000},toolInvocationToken:undefined});
  assert(expanded.content.some(c=>c.value?.includes('getEncoding')));
  console.log('RepoSqueeze extension host: activation, tool registration, context and expansion passed.');
};
