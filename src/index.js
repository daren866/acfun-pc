const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('node:path');
const https = require('node:https');
const querystring = require('node:querystring');
const fs = require('node:fs');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// 隐藏菜单
Menu.setApplicationMenu(null);

// 存储登录cookie
let loginCookies = {};
// 缓存当前登录用户ID
let currentUserId = '';

// Cookie 持久化过期时间：1年后（秒级时间戳）
const PERSIST_EXPIRES = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

// 通用的浏览器请求头
const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Referer': 'https://www.acfun.cn/',
  'Origin': 'https://www.acfun.cn',
  'Accept': 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
};

// 工具：把 set-cookie 数组解析成 {name: value}
function parseSetCookies(setCookieHeader) {
  const parsed = {};
  if (!setCookieHeader) return parsed;
  for (const raw of setCookieHeader) {
    const m = raw.match(/^([^=;]+)=([^;]*)/);
    if (!m) continue;
    parsed[m[1].trim()] = m[2];
  }
  return parsed;
}

// 工具：从 session 读取指定域名所有 cookie，拼成 Cookie 请求头字符串
async function getCookieString(url) {
  try {
    const cookies = await session.defaultSession.cookies.get({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    console.warn('读取cookie失败:', e.message);
    return '';
  }
}

// 工具：将 set-cookie 持久化写入 session
async function persistCookies(setCookieHeader, url) {
  if (!setCookieHeader) return;
  for (const raw of setCookieHeader) {
    const m = raw.match(/^([^=;]+)=([^;]*)/);
    if (!m) continue;
    const name = m[1].trim();
    const value = m[2];
    const domainMatch = raw.match(/domain=([^;]+)/i);
    const pathMatch = raw.match(/path=([^;]+)/i);

    try {
      await session.defaultSession.cookies.set({
        url,
        name,
        value,
        domain: domainMatch ? domainMatch[1].trim() : undefined,
        path: pathMatch ? pathMatch[1].trim() : '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        expirationDate: PERSIST_EXPIRES,
      });
    } catch (e) {
      console.warn('持久化cookie失败:', name, e.message);
    }
  }
}

// 工具：清空 acfun 相关 cookie（退出登录）
async function clearAcFunCookies() {
  try {
    const cookies = await session.defaultSession.cookies.get({});
    for (const c of cookies) {
      const domain = c.domain || '';
      if (domain.includes('acfun.cn')) {
        const url = `https://${domain.replace(/^\./, '')}${c.path || '/'}`;
        try {
          await session.defaultSession.cookies.remove(url, c.name);
        } catch (_) {}
      }
    }
    loginCookies = {};
    currentUserId = '';
  } catch (e) {
    console.warn('清空cookie失败:', e.message);
  }
}

// API配置
const apiConfigs = [
  { pcursor: '1782626881443', blockId: '6', recPosition: '0' },
  { pcursor: '1782614750390', blockId: '19', recPosition: '0' },
  { pcursor: '1782575456492', blockId: '4', recPosition: '0' },
  { pcursor: '1782623843417', blockId: '274', recPosition: '0' },
  { pcursor: '1782546700559', blockId: '167', recPosition: '0' }
];

function getRandomIndex() {
  return Math.floor(Math.random() * 5) + 1;
}

function getApiUrl(index) {
  const config = apiConfigs[index - 1];
  return `https://www.acfun.cn/home/block/data?pcursor=${config.pcursor}&blockId=${config.blockId}&recPosition=${config.recPosition}`;
}

function parseHtmlVideos(html) {
  const videos = [];
  const cardRegex = /<div class="normal-video log-item"[^>]*data-mediaid="(\d+)"[^>]*>.*?<\/div>\s*<\/div>/gs;
  const matches = html.matchAll(cardRegex);

  for (const match of matches) {
    const cardHtml = match[0];
    const titleMatch = cardHtml.match(/alt="([^"]+)"/);
    const title = titleMatch ? titleMatch[1] : '';
    const coverMatch = cardHtml.match(/src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
    const coverUrl = coverMatch ? coverMatch[1] : '';
    const upMatch = cardHtml.match(/UP:([^&#]+)/);
    const upName = upMatch ? upMatch[1].trim() : '';
    const linkMatch = cardHtml.match(/href="\/v\/ac(\d+)"/);
    const videoId = linkMatch ? linkMatch[1] : '';
    const timeMatch = cardHtml.match(/<span class="video-time">([^<]+)<\/span>/);
    const duration = timeMatch ? timeMatch[1] : '';

    videos.push({
      title,
      coverUrl,
      upName,
      videoId,
      duration,
      link: `https://www.acfun.cn/v/ac${videoId}`
    });
  }

  return videos;
}

function fetchFeed(randomIndex = null) {
  const index = randomIndex || getRandomIndex();
  const url = getApiUrl(index);

  const options = {
    headers: { ...COMMON_HEADERS }
  };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          if (jsonData && jsonData.tpl) {
            resolve(parseHtmlVideos(jsonData.tpl));
          } else {
            resolve([]);
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

ipcMain.handle('feed-init', async () => {
  try {
    return await fetchFeed();
  } catch (error) {
    return [];
  }
});

ipcMain.handle('feed-loadMore', async () => {
  try {
    return await fetchFeed();
  } catch (error) {
    return [];
  }
});

function fetchVideoPlayInfo(videoId) {
  const url = `https://www.acfun.cn/v/ac${videoId}`;

  const options = {
    headers: {
      ...COMMON_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          console.log('\n📄 视频页面原始内容片段:', data.substring(0, 500) + '...');

          // 优化 api_st 提取：尝试多种可能的格式
          let apiSt = '';
          let matchSource = '';
          let allMatches = [];

          // 尝试从 window.api_st 提取
          const apiStMatch1 = data.match(/window\.api_st\s*=\s*"([^"]+)"/);
          if (apiStMatch1) {
            apiSt = apiStMatch1[1];
            matchSource = 'window.api_st';
            allMatches.push({ source: 'window.api_st', value: apiSt });
          }

          // 尝试从 "api_st" 字段提取
          if (!apiSt) {
            const apiStMatch2 = data.match(/"api_st"\s*:\s*"([^"]+)"/);
            if (apiStMatch2) {
              apiSt = apiStMatch2[1];
              matchSource = '"api_st" 字段';
              allMatches.push({ source: '"api_st" 字段', value: apiSt });
            }
          }

          // 尝试从 acfun.midground.api_st 提取
          if (!apiSt) {
            const apiStMatch3 = data.match(/acfun\.midground\.api_st\s*=\s*"([^"]+)"/);
            if (apiStMatch3) {
              apiSt = apiStMatch3[1];
              matchSource = 'acfun.midground.api_st';
              allMatches.push({ source: 'acfun.midground.api_st', value: apiSt });
            }
          }

          // 尝试从 pageInfo 对象提取
          if (!apiSt) {
            const pageInfoMatch = data.match(/window\.pageInfo\s*=\s*({[\s\S]*?});/);
            if (pageInfoMatch) {
              try {
                const pageInfo = JSON.parse(pageInfoMatch[1]);
                apiSt = pageInfo.api_st || pageInfo['acfun.midground.api_st'] || '';
                if (apiSt) {
                  matchSource = 'pageInfo 对象';
                  allMatches.push({ source: 'pageInfo 对象', value: apiSt });
                }
              } catch (e) {
                console.warn('解析 pageInfo 失败:', e.message);
              }
            }
          }

          // 尝试从 cookie 中提取（作为最后的 fallback）
          if (!apiSt) {
            const cookieMatch = data.match(/setCookie\("acfun\.midground\.api_st",\s*"([^"]+)"\)/);
            if (cookieMatch) {
              apiSt = cookieMatch[1];
              matchSource = 'setCookie 调用';
              allMatches.push({ source: 'setCookie 调用', value: apiSt });
            }
          }

          console.log(`🔑 提取到的 api_st: ${apiSt || '未找到'}`);
          console.log(`📝 匹配来源: ${matchSource || '无匹配'}`);
          console.log('🔍 所有匹配尝试:', JSON.stringify(allMatches, null, 2));

          const videoInfoMatch = data.match(/window\.videoInfo\s*=\s*({[\s\S]*?});/);
          if (videoInfoMatch) {
            const videoData = JSON.parse(videoInfoMatch[1]);
            if (videoData.currentVideoInfo && videoData.currentVideoInfo.ksPlayJson) {
              const ksPlayJson = JSON.parse(videoData.currentVideoInfo.ksPlayJson);
              const playUrls = [];
              if (ksPlayJson.adaptationSet && ksPlayJson.adaptationSet.length > 0) {
                ksPlayJson.adaptationSet.forEach((set) => {
                  if (set.representation && set.representation.length > 0) {
                    set.representation.forEach((rep) => {
                      playUrls.push({
                        quality: rep.qualityType || rep.qualityLabel || 'unknown',
                        qualityLabel: rep.qualityLabel || '',
                        url: rep.url || '',
                        width: rep.width || 0,
                        height: rep.height || 0
                      });
                    });
                  }
                });
              }
              resolve({
                success: true,
                title: videoData.title || '',
                coverUrl: videoData.coverUrl || '',
                upName: videoData.user ? videoData.user.name : '',
                upAvatar: videoData.user && videoData.user.headCdnUrls && videoData.user.headCdnUrls.length > 0
                  ? videoData.user.headCdnUrls[0].url
                  : (videoData.user && videoData.user.avatarImage) || '',
                fanCount: videoData.user ? videoData.user.fanCount || '' : '',
                likeCount: videoData.likeCount || 0,
                stowCount: videoData.stowCount || 0,
                bananaCount: videoData.bananaCount || 0,
                viewCount: videoData.viewCount || 0,
                description: videoData.description || '',
                playUrls: playUrls,
                apiSt: apiSt
              });
            } else {
              resolve({ success: false, error: '未找到播放信息' });
            }
          } else {
            resolve({ success: false, error: '未找到videoInfo' });
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

ipcMain.handle('get-video-play-info', async (event, videoId) => {
  try {
    return await fetchVideoPlayInfo(videoId);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

function fetchComments(sourceId, page = 1) {
  const url = `https://www.acfun.cn/rest/pc-direct/comment/list?sourceId=${sourceId}&sourceType=3&page=${page}&pivotCommentId=0&newPivotCommentId=&t=${Date.now()}&supportZtEmot=true`;
  const options = { headers: { ...COMMON_HEADERS } };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          if (jsonData.rootComments) {
            const comments = jsonData.rootComments.map((comment) => ({
              userId: comment.userId || '',
              userName: comment.userName || '',
              content: comment.content || '',
              likeCount: comment.likeCount || 0,
              createTime: comment.postDate || '',
              avatar: comment.headUrl && comment.headUrl.length > 0 ? comment.headUrl[0].url : ''
            }));
            resolve({
              success: true,
              comments: comments,
              totalCount: jsonData.totalCount || comments.length,
              hasMore: jsonData.totalPage > page,
              totalPage: jsonData.totalPage || 1
            });
          } else {
            resolve({ success: false, error: '获取评论失败' });
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

ipcMain.handle('get-video-comments', async (event, sourceId, page) => {
  try {
    return await fetchComments(sourceId, page);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ==================== 登录 ====================

function login(username, password) {
  const url = 'https://id.app.acfun.cn/rest/web/login/signin';
  const { hostname, pathname, search } = new URL(url);

  const postData = querystring.stringify({
    username,
    password,
    key: '',
    captcha: '',
  });

  const options = {
    method: 'POST',
    hostname,
    path: pathname + search,
    headers: {
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'cache-control': 'no-cache',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'content-length': Buffer.byteLength(postData),
      'pragma': 'no-cache',
      'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'Referer': 'https://www.acfun.cn/',
      'Origin': 'https://www.acfun.cn',
      'User-Agent': COMMON_HEADERS['User-Agent'],
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, async (res) => {
      const cookies = res.headers['set-cookie'];
      loginCookies = parseSetCookies(cookies);
      await persistCookies(cookies, 'https://id.app.acfun.cn/');
      await persistCookies(cookies, 'https://www.acfun.cn/');

      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.result === 0) {
            resolve({
              success: true,
              cookies: loginCookies,
              message: '登录成功',
              userId: result.userId,
              username: result.username,
              avatar: result.img || '',
            });
          } else {
            resolve({ success: false, error: result.error_msg || result.msg || '登录失败' });
          }
        } catch (error) {
          resolve({ success: false, error: '登录响应解析失败' });
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.write(postData);
    req.end();
  });
}

ipcMain.handle('login', async (event, username, password) => {
  try {
    const result = await login(username, password);
    if (result.success) {
      const info = await fetchPersonalBasicInfo();
      if (info.success) {
        currentUserId = String(info.userId);
        result.userId = info.userId;
        result.username = info.username;
        result.avatar = info.avatar;
      }
    }
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ==================== 获取个人资料 ====================

async function fetchPersonalBasicInfo() {
  const url = 'https://www.acfun.cn/rest/pc-direct/user/personalBasicInfo';
  const { hostname, pathname, search } = new URL(url);

  const cookieStr = await getCookieString('https://www.acfun.cn/');

  const options = {
    method: 'GET',
    hostname,
    path: pathname + search,
    headers: {
      ...COMMON_HEADERS,
      'Cookie': cookieStr,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.result === 0 && result.info) {
            currentUserId = String(result.info.userId);
            resolve({
              success: true,
              userId: result.info.userId,
              username: result.info.userName || '',
              avatar: result.info.headUrl || '',
              signature: result.info.signature || '',
              raw: result.info,
            });
          } else {
            resolve({ success: false, error: '未登录或登录已失效' });
          }
        } catch (e) {
          resolve({ success: false, error: '解析个人资料失败' });
        }
      });
    });
    req.on('error', (error) => resolve({ success: false, error: error.message }));
    req.end();
  });
}

ipcMain.handle('get-user-info', async () => {
  return await fetchPersonalBasicInfo();
});

async function restoreLoginState() {
  const info = await fetchPersonalBasicInfo();
  if (info.success) {
    currentUserId = String(info.userId);
    return {
      logged: true,
      userId: info.userId,
      username: info.username,
      avatar: info.avatar,
    };
  }
  return { logged: false };
}

ipcMain.handle('restore-login', async () => {
  return await restoreLoginState();
});

ipcMain.handle('logout', async () => {
  await clearAcFunCookies();
  return { success: true };
});

// ==================== 点赞功能 ====================

function getLikedFilePath() {
  return path.join(app.getPath('userData'), 'likedVideos.json');
}

function readLikedVideos() {
  try {
    const fp = getLikedFilePath();
    if (!fs.existsSync(fp)) return [];
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeLikedVideos(arr) {
  try {
    fs.writeFileSync(getLikedFilePath(), JSON.stringify(arr, null, 2), 'utf-8');
  } catch (e) {}
}

// 点赞/取消点赞接口
async function interactVideo(videoId, action, apiSt) {
  const endpoint = action === 'add' ? 'add' : 'delete';
  const url = `https://kuaishouzt.com/rest/zt/interact/${endpoint}`;
  const { hostname, pathname } = new URL(url);

  if (!apiSt) {
    console.error('❌ 点赞失败：api_st 为空，请检查登录状态或页面解析');
    return { success: false, error: 'Token 为空，可能未登录或页面解析失败' };
  }

  if (!currentUserId) {
    console.error('❌ 点赞失败：用户ID为空，请检查登录状态');
    return { success: false, error: '用户ID为空，请重新登录' };
  }

  // 构建请求体
  const body = querystring.stringify({
    kpn: 'ACFUN_APP',
    kpf: 'PC_WEB',
    subBiz: 'mainApp',
    interactType: '1',
    objectType: '2',
    objectId: String(videoId),
    'acfun.midground.api_st': apiSt,
    userId: currentUserId,
  }) + '&extParams%5BisPlaying%5D=false&extParams%5BshowCount%5D=1&extParams%5BotherBtnClickedCount%5D=10&extParams%5BplayBtnClickedCount%5D=0';

  console.log('\n🔍 点赞请求详情：');
  console.log('📌 接口:', url);
  console.log('🔑 Action:', action);
  console.log('🎯 Video ID:', videoId);
  console.log('📝 请求体:', body);
  console.log('🔑 api_st:', apiSt);
  console.log('👤 User ID:', currentUserId);

  // 获取 Cookie
  const cookieStr = await getCookieString('https://www.acfun.cn/');
  console.log('🍪 Cookie:', cookieStr);

  // 构建请求头
  const headers = {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'content-length': Buffer.byteLength(body),
    'pragma': 'no-cache',
    'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-storage-access': 'active',
    'Referer': 'https://www.acfun.cn/',
    'Origin': 'https://www.acfun.cn',
    'User-Agent': COMMON_HEADERS['User-Agent'],
    'Cookie': cookieStr,
  };
  console.log('📋 请求头:', JSON.stringify(headers, null, 2));

  return new Promise((resolve) => {
    const req = https.request({
      method: 'POST',
      hostname,
      path: pathname,
      headers: headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        console.log('📤 点赞响应:', data);
        try {
          const json = JSON.parse(data);
          if (json.result === 0) { 
            console.log('✅ 点赞成功');
            resolve({ success: true, data: json });
          } else {
            console.error('❌ 点赞失败:', json.error_msg || '操作失败');
            resolve({ success: false, error: json.error_msg || '操作失败' });
          }
        } catch (e) {
          console.error('❌ 响应解析失败:', e.message);
          resolve({ success: false, error: '解析失败' });
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ 网络错误:', e.message);
      resolve({ success: false, error: e.message });
    });
    req.write(body);
    req.end();
  });
}

// IPC 处理器
ipcMain.handle('toggle-like-video', async (event, videoId, isLike, apiSt) => {
  const action = isLike ? 'add' : 'delete';
  const result = await interactVideo(videoId, action, apiSt);
  
  if (result.success) {
    const likedArr = readLikedVideos();
    if (isLike) {
      if (!likedArr.includes(videoId)) likedArr.push(videoId);
    } else {
      const idx = likedArr.indexOf(videoId);
      if (idx > -1) likedArr.splice(idx, 1);
    }
    writeLikedVideos(likedArr);
  }
  
  return result;
});

ipcMain.handle('check-video-liked', async (event, videoId) => {
  return readLikedVideos().includes(videoId);
});

// ==================== 调试信息转发 ====================

// 接收视频页面的调试信息
ipcMain.on('video-debug-info', (event, info) => {
  console.log('📱 视频页面调试信息:', info);
  
  // 获取所有窗口
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(window => {
    if (window.webContents.getURL().includes('index.html')) {
      // 向index.html发送调试信息
      window.webContents.send('debug-info', info);
    }
  });
});

// ==================== 打开视频窗口 ====================

ipcMain.handle('open-video', async (event, video) => {
  const videoWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const videoData = encodeURIComponent(JSON.stringify(video));
  videoWindow.loadFile(path.join(__dirname, 'video.html'), {
    query: { video: videoData }
  });

  return true;
});

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.openDevTools();
};

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
