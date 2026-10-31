import * as vscode from 'vscode';
import { Engine } from './engine.js';
import { repositoryMap } from './context.js';
import { INSTRUCTIONS } from './instructions.js';
import { findSymbols, renderOutline, renderSymbols } from './symbols.js';

interface ContextInput {query:string;budget?:number}
interface ExpandInput {path:string;start:number;end:number;budget?:number}
interface MapInput {path?:string;query?:string;budget?:number}
export function activate(context: vscode.ExtensionContext) {
  const repositories = new Map<string,Engine>();
  const getRepo = () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before indexing.');
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local repository folder first.');
    const model=vscode.workspace.getConfiguration('reposqueezeV2').get<string>('semanticModel','');
    const features=vscode.workspace.getConfiguration('reposqueezeV2').get<string>('features','');
    const key=folder.uri.fsPath+'\0'+model+'\0'+features;
    if (!repositories.has(key)) repositories.set(key,new Engine(folder.uri.fsPath,{semanticModel:model||undefined,features:features||undefined}));
    return repositories.get(key)!;
  };
  const defaultBudget = () => vscode.workspace.getConfiguration('reposqueezeV2').get<number>('tokenBudget',3000);
  const show = async (text: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument({content:text,language:'markdown'}),{preview:true});
  context.subscriptions.push(vscode.commands.registerCommand('reposqueeze-v2.pack',async () => {
    const query = await vscode.window.showInputBox({prompt:'What do you want to understand or change?',placeHolder:'Where is retry backoff calculated?'});
    if (!query) return;
    try {
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'RepoSqueeze V2: reading repository'},async () => {
        const result = await getRepo().context(query,defaultBudget());
        await show(result.text);
        vscode.window.showInformationMessage(`RepoSqueeze V2: ${result.stats.outputTokens.toLocaleString()} tokens (${result.stats.tokenizer}); ${(result.stats.reduction*100).toFixed(1)}% smaller than full indexed repository. This is not measured billing savings.`);
      });
    } catch(e) { vscode.window.showErrorMessage(String(e)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('reposqueeze-v2.map',async () => {
    try { await show(repositoryMap(await getRepo().snapshot('__repository_map__'),defaultBudget())); } catch(e) {vscode.window.showErrorMessage(String(e));}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('reposqueeze-v2.setup',async () => {
    try {
      const repo = getRepo();
      const dir = vscode.Uri.file(`${repo.root}/.github/instructions`);
      const target = vscode.Uri.joinPath(dir,'reposqueeze-v2.instructions.md');
      try { await vscode.workspace.fs.stat(target); await vscode.window.showTextDocument(target); return; } catch {}
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(target,Buffer.from(`---\napplyTo: "**"\n---\n${INSTRUCTIONS}`));
      await vscode.window.showTextDocument(target);
    } catch(e) {vscode.window.showErrorMessage(String(e));}
  }));
  context.subscriptions.push(vscode.lm.registerTool<ContextInput>('reposqueeze_v2_context',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const pack = await getRepo().context(options.input.query,options.input.budget ?? defaultBudget());
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(pack.text)]);
    }
  }));
  context.subscriptions.push(vscode.lm.registerTool<ExpandInput>('reposqueeze_v2_expand',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const {path,start,end,budget} = options.input;
      const text = await getRepo().expandRange(path,start,end,budget ?? defaultBudget());
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
  }));
  context.subscriptions.push(vscode.lm.registerTool<MapInput>('reposqueeze_v2_map',{
    async invoke(options,token) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const {path,query,budget} = options.input;
      const repo = getRepo();
      const limit = budget ?? 1500;
      let text: string;
      if (path) {
        const file = (await repo.snapshot(path)).files.find(candidate => candidate.path === path);
        if (!file) throw new Error('Path is excluded, absent, outside repository, or beyond scan limits');
        text = renderOutline(file.path,file.chunks,file.text.split('\n').length,limit);
      } else {
        const snapshot = await repo.snapshot(query ?? '__repository_map__');
        text = query ? renderSymbols(findSymbols(snapshot,query),limit) : repositoryMap(snapshot,limit);
      }
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
  }));
}
export function deactivate() {}
