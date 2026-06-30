// Preload script - 安全地暴露主进程API给渲染进程
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('feedAPI', {
  // Feed 相关
  init: () => ipcRenderer.invoke('feed-init'),
  loadMore: () => ipcRenderer.invoke('feed-loadMore'),
  openVideo: (video) => ipcRenderer.invoke('open-video', video),
  getVideoPlayInfo: (videoId) => ipcRenderer.invoke('get-video-play-info', videoId),
  getVideoComments: (sourceId, page) => ipcRenderer.invoke('get-video-comments', sourceId, page),

  // 搜索相关
  search: (keyword) => ipcRenderer.invoke('search', keyword),

  // 登录相关
  login: (username, password) => ipcRenderer.invoke('login', username, password),
  getUserInfo: () => ipcRenderer.invoke('get-user-info'),
  restoreLogin: () => ipcRenderer.invoke('restore-login'),
  logout: () => ipcRenderer.invoke('logout'),

  // 点赞相关
  toggleLikeVideo: (videoId, isLike) => ipcRenderer.invoke('toggle-like-video', videoId, isLike),
  checkVideoLiked: (videoId) => ipcRenderer.invoke('check-video-liked', videoId),

  // 香蕉打赏相关
  sendBanana: (videoId, count) => ipcRenderer.invoke('send-banana', videoId, count),

  // 弹幕相关
  getDanmaku: (videoId) => ipcRenderer.invoke('get-danmaku', videoId),

  // 个人空间相关
  openSpace: () => ipcRenderer.invoke('open-space'),
  getSpacePage: () => ipcRenderer.invoke('get-space-page'),

  // 调试功能
  sendDebugInfo: (info) => ipcRenderer.send('video-debug-info', info),

  // 调试：快速跳转到指定视频
  gotoVideo: (videoId) => ipcRenderer.invoke('goto-video', videoId),
});

// 暴露调试信息接收和调试API
contextBridge.exposeInMainWorld('debugAPI', {
  onDebugInfo: (callback) => ipcRenderer.on('debug-info', (event, info) => callback(info)),
  onGotoVideo: (callback) => ipcRenderer.on('goto-video', (event, videoId) => callback(videoId)),
});
