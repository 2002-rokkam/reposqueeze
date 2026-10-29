import * as vscode from 'vscode';
import { Engine } from './engine.js';
import { contextPack, expand, repositoryMap } from './context.js';
import { INSTRUCTIONS } from './instructions.js';

interface ContextInput {query:string;budget?:number}
interface ExpandInput {path:string;start:number;end:number;budget?:number}
export function activate(context: vscode.ExtensionContext) {
  const repositories = new Map<string,Engine>();
  const getRepo = () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before indexing.');
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local repository folder first.');
    const model=vscode.workspace.getConfiguration('reposqueeze').get<string>('semanticModel','');
    const key=folder.uri.fsPath+'\0'+model;
    if (!repositories.has(key)) repositories.set(key,new Engine(folder.uri.fsPath,model));
    return repositories.get(key)!;
  };
  const defaultBudget = () => vscode.workspace.getConfiguration('reposqueeze').get<number>('tokenBudget',3000);
  const show = async (text: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:text,language:'markdown'}),{preview:true});
  context.subscriptions.push(vscode.commands.registerCommand('reposqueeze.pack',async () => {
    const query = await vscode.window.showInputBox({prompt:'What do you want to understand or change?',placeHolder:'Where is retry backoff calculated?'});
    if (!query) return;
    try {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'RepoSqueeze: reading repository'},async () => {
        const result = await getRepo().context(query,defaultBudget());
        await show(result.text);
        vscode.window.showInformationMessage(`RepoSqueeze: ${result.stats.outputTokens.toLocaleString()} tokens (${result.stats.tokenizer}); ${(result.stats.reduction*100).toFixed(1)}% smaller than full indexed repository. This is not measured billing savings.`);
      });
    } catch(e) { vscode.window.showErrorMessage(String(e)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('reposqueeze.map',async () => {
    try { await show(repositoryMap(await getRepo().snapshot(),defaultBudget())); } catch(e) {vscode.window.showErrorMessage(String(e));}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('reposqueeze.setup',async () => {
    try {
      const repo = getRepo();
      const dir = vscode.Uri.file(`${repo.root}/.github/instructions`);
      const target = vscode.Uri.joinPath(dir,'reposqueeze.instructions.md');
      try { await vscode.workspace.fs.stat(target); await vscode.window.showTextDocument(target); return; } catch {}
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(target,Buffer.from(`---\napplyTo: "**"\n---\n${INSTRUCTIONS}`));
      await vscode.window.showTextDocument(target);
    } catch(e) {vscode.window.showErrorMessage(String(e));}
  }));
  context.subscriptions.push(vscode.lm.registerTool<ContextInput>('reposqueeze_context',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const pack = await getRepo().context(options.input.query,options.input.budget ?? defaultBudget());
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(pack.text)]);
    }
  }));
  context.subscriptions.push(vscode.lm.registerTool<ExpandInput>('reposqueeze_expand',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const s = await getRepo().snapshot();
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const {path,start,end,budget} = options.input;
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(expand(s,path,start,end,budget ?? defaultBudget()))]);
    }
  }));
}
export function deactivate() {}
