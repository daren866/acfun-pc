// Preload script - 安全地暴露主进程API给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('feedAPI', {
  // Feed 相关
  init: () => ipcRenderer.invoke('feed-init'),
  loadMore: () => ipcRenderer.invoke('feed-loadMore'),
  openVideo: (video) => ipcRenderer.invoke('open-video', video),
  getVideoPlayInfo: (videoId) => ipcRenderer.invoke('get-video-play-info', videoId),
  getVideoComments: (sourceId, page) => ipcRenderer.invoke('get-video-comments', sourceId, page),

  // 登录相关
  login: (username, password) => ipcRenderer.invoke('login', username, password),
  getUserInfo: () => ipcRenderer.invoke('get-user-info'),
  restoreLogin: () => ipcRenderer.invoke('restore-login'),
  logout: () => ipcRenderer.invoke('logout'),

  // 点赞相关
  toggleLikeVideo: (videoId, isLike, apiSt) => ipcRenderer.invoke('toggle-like-video', videoId, isLike, apiSt),
  checkVideoLiked: (videoId) => ipcRenderer.invoke('check-video-liked', videoId),

  // 调试功能
  sendDebugInfo: (info) => ipcRenderer.send('video-debug-info', info),
});

// 暴露调试信息接收
contextBridge.exposeInMainWorld('debugAPI', {
  onDebugInfo: (callback) => ipcRenderer.on('debug-info', (event, info) => callback(info)),
});
