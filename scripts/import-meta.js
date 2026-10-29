import { pathToFileURL } from 'node:url';
export const importMetaUrl = pathToFileURL(__filename).href;
