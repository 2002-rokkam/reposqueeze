import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';
await runTests({
  ...(process.env.VSCODE_EXECUTABLE_PATH?{vscodeExecutablePath:process.env.VSCODE_EXECUTABLE_PATH}:{}),
  extensionDevelopmentPath:process.cwd(),extensionTestsPath:resolve('tests/extension-host.cjs'),
  launchArgs:[process.cwd(),'--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--user-data-dir',resolve('.vscode-test/user-data'),'--extensions-dir',resolve('.vscode-test/extensions')]
});
