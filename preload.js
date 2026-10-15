const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (arg) => ipcRenderer.invoke(ch, arg);
contextBridge.exposeInMainWorld('api', {
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  pickFolder: call('dialog:folder'),
  compare: call('compare'),
  models: call('ollama:models'),
  aiMerge: call('ollama:merge'),
  validateChunk: call('validate:chunk'),
  verify: call('verify:run'),
  write: call('result:write')
});