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
// 缓存登录token
let cachedTokens = {
  ssecurity: '',
  api_st: '',
  api_at: ''
};

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

// 统一日志函数
function logApiRequest(apiName, url, method = 'GET', body = null) {
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${timestamp}] [${apiName}] ${method} ${url}`);
  if (body) {
    console.log(`[${timestamp}] [${apiName}] Body:`, body);
  }
}

function logApiResponse(apiName, statusCode, data = null) {
  const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${timestamp}] [${apiName}] Response: ${statusCode}`);
  if (data) {
    const dataStr = typeof data === 'object' ? JSON.stringify(data).substring(0, 500) : String(data);
    console.log(`[${timestamp}] [${apiName}] Data:`, dataStr);
  }
}

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
  
  logApiRequest('feed', url);

  const options = {
    headers: { ...COMMON_HEADERS }
  };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        logApiResponse('feed', res.statusCode);
        try {
          const jsonData = JSON.parse(data);
          if (jsonData && jsonData.tpl) {
            resolve(parseHtmlVideos(jsonData.tpl));
          } else {
            resolve([]);
          }
        } catch (error) {
          console.error('[feed] 解析失败:', error.message);
          reject(error);
        }
      });
    }).on('error', (error) => {
      console.error('[feed] 请求失败:', error.message);
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

// 搜索功能
ipcMain.handle('search', async (event, keyword) => {
  try {
    const result = await searchVideos(keyword);
    return result;
  } catch (error) {
    console.error('搜索失败:', error);
    return [];
  }
});

async function searchVideos(keyword) {
  const encodedKeyword = encodeURIComponent(keyword);
  const url = `https://www.acfun.cn/search?type=video&keyword=${encodedKeyword}`;

  console.log(`\n🔍 搜索请求 - URL: ${url}`);

  const cookieStr = await getCookieString('https://www.acfun.cn/');
  console.log(`🍪 搜索请求 Cookie 长度: ${cookieStr.length}`);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'pragma': 'no-cache',
    'Cookie': cookieStr,
    'Referer': 'https://www.acfun.cn/',
  };

  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET',
      hostname: 'www.acfun.cn',
      path: `/search?type=video&keyword=${encodedKeyword}`,
      headers: headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        console.log(`📋 搜索响应: ${res.statusCode}`);
        console.log(`📋 搜索响应长度: ${data.length}`);
        logApiResponse('search', res.statusCode, data);

        try {
          // 解析 bigPipe.onPageletArrive 中的视频数据
          let videos = [];
          
          // 匹配 bigPipe.onPageletArrive({"container":"","id":"pagelet_video","html":"...",...})
          const bigPipeRegex = /bigPipe\.onPageletArrive\(({[\s\S]*?})\);/g;
          let match;
          let videoHtml = '';
          let pageletCount = 0;
          
          while ((match = bigPipeRegex.exec(data)) !== null) {
            try {
              const jsonStr = match[1];
              const pageletData = JSON.parse(jsonStr);
              pageletCount++;
              console.log(`📋 找到 pagelet[${pageletCount}]: ${pageletData.id}`);
              
              if (pageletData.id === 'pagelet_video' && pageletData.html) {
                videoHtml = pageletData.html;
                console.log('📋 找到 pagelet_video HTML');
                break;
              }
              
              // 也从综合搜索中提取视频
              if (pageletData.id === 'pagelet_complex' && pageletData.html) {
                const complexVideos = parseSearchResults(pageletData.html);
                if (complexVideos.length > 0) {
                  console.log(`📋 从 pagelet_complex 找到 ${complexVideos.length} 个视频`);
                  videos = complexVideos;
                }
              }
            } catch (e) {
              // 解析失败跳过
            }
          }
          
          console.log(`📋 共找到 ${pageletCount} 个 pagelet`);
          
          if (videoHtml) {
            videos = parseSearchResults(videoHtml);
          }
          
          // 如果没找到，尝试直接从整个响应中提取
          if (videos.length === 0) {
            console.log('📋 尝试直接从响应中提取视频信息');
            videos = parseSearchResultsDirect(data);
          }
          
          console.log(`📋 最终解析到 ${videos.length} 个视频`);
          resolve(videos);
        } catch (e) {
          console.error('解析搜索结果失败:', e);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.error('搜索请求失败:', e.message);
      resolve([]);
    });
    req.end();
  });
}

function parseSearchResults(html) {
  const videos = [];

  // 解析视频项 - 从搜索结果页面中提取
  const videoCards = html.match(/<a[^>]*href="\/v\/ac(\d+)"[^>]*>[\s\S]*?<\/a>/g) || [];
  
  console.log(`📊 找到 ${videoCards.length} 个视频卡片`);
  
  for (const card of videoCards) {
    // 提取视频ID
    const idMatch = card.match(/href="\/v\/ac(\d+)"/);
    if (!idMatch) continue;
    const videoId = idMatch[1];
    
    // 提取封面
    const coverMatch = card.match(/<img[^>]*src="([^"]+)"[^>]*>/);
    const coverUrl = coverMatch ? coverMatch[1] : '';
    
    // 提取标题
    const titleMatch = card.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/(span|div|a)>/i) ||
                      card.match(/alt="([^"]+)"/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '未知标题';
    
    // 提取作者
    const authorMatch = card.match(/class="[^"]*author[^"]*"[^>]*>([\s\S]*?)<\/(span|div|a)>/i) ||
                        card.match(/class="[^"]*up[^"]*"[^>]*>([\s\S]*?)<\/(span|div|a)>/i);
    const upName = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : '未知UP主';
    
    videos.push({ videoId, title, coverUrl, upName });
  }
  
  // 如果上面的方式没找到，尝试更简单的方法
  if (videos.length === 0) {
    const videoIds = [];
    const idMatches = html.match(/href="\/v\/ac(\d+)"/g) || [];
    for (const m of idMatches) {
      const id = m.match(/ac(\d+)/)[1];
      if (!videoIds.includes(id)) videoIds.push(id);
    }
    
    const imgSrcs = [];
    const imgMatches = html.match(/src="(https?:\/\/[^"]*acfun[^"]*(?:cover|thumbnail)[^"]*)"/gi) || [];
    for (const m of imgMatches) {
      const src = m.match(/src="([^"]+)"/i)[1];
      if (!imgSrcs.includes(src)) imgSrcs.push(src);
    }
    
    console.log(`📊 回退方式 - ids: ${videoIds.length}, imgs: ${imgSrcs.length}`);
    
    for (let i = 0; i < Math.min(videoIds.length, 20); i++) {
      videos.push({
        videoId: videoIds[i],
        title: '视频 ' + (i + 1),
        coverUrl: imgSrcs[i] || '',
        upName: ''
      });
    }
  }

  console.log(`📊 解析到 ${videos.length} 个视频`);
  return videos;
}

function parseSearchResultsDirect(data) {
  const videos = [];

  // 直接在响应中查找视频链接
  const videoIdSet = new Set();
  const videoIdMatches = data.match(/href="\/v\/ac(\d+)"/g);
  if (videoIdMatches) {
    for (const match of videoIdMatches) {
      const videoId = match.match(/ac(\d+)/)[1];
      videoIdSet.add(videoId);
    }
  }

  // 查找 HTML 中的图片
  const imgSrcSet = new Set();
  const imgMatches = data.match(/src="(https?:\/\/[^"]*acfun[^"]*(?:cover|thumbnail)[^"]*)"/g);
  if (imgMatches) {
    for (const match of imgMatches) {
      const src = match.match(/src="([^"]+)"/)[1];
      imgSrcSet.add(src);
    }
  }

  // 如果没找到cover/thumbnail，尝试找任何 acfun.cn 的图片
  if (imgSrcSet.size === 0) {
    const anyImgMatches = data.match(/src="(https?:\/\/[^"]*acfun\.cn[^"]*)"/g);
    if (anyImgMatches) {
      for (const match of anyImgMatches) {
        const src = match.match(/src="([^"]+)"/)[1];
        if (!src.includes('avatar') && !src.includes('header') && !src.includes('logo')) {
          imgSrcSet.add(src);
        }
      }
    }
  }

  // 查找标题
  const titleSet = new Set();
  const titleMatches = data.match(/class="title"[^>]*>([^<]+)<\/span>/g);
  if (titleMatches) {
    for (const match of titleMatches) {
      const title = match.replace(/class="title"[^>]*>/, '').replace(/<\/?span[^>]*>/g, '').trim();
      if (title) titleSet.add(title);
    }
  }

  // 查找作者
  const authorSet = new Set();
  const authorMatches = data.match(/class="author"[^>]*>([^<]+)<\/span>/g);
  if (authorMatches) {
    for (const match of authorMatches) {
      const author = match.replace(/class="author"[^>]*>/, '').replace(/<\/?span[^>]*>/g, '').trim();
      if (author) authorSet.add(author);
    }
  }

  console.log(`📊 直接解析 - videoIds: ${videoIdSet.size}, images: ${imgSrcSet.size}, titles: ${titleSet.size}, authors: ${authorSet.size}`);

  const videoIds = Array.from(videoIdSet);
  const images = Array.from(imgSrcSet);
  const titles = Array.from(titleSet);
  const authors = Array.from(authorSet);

  for (let i = 0; i < Math.min(videoIds.length, 20); i++) {
    videos.push({
      videoId: videoIds[i],
      title: titles[i] || '未知标题',
      coverUrl: images[i] || '',
      upName: authors[i] || '未知UP主'
    });
  }

  return videos;
}

async function fetchVideoPlayInfo(videoId) {
  const url = `https://www.acfun.cn/v/ac${videoId}`;
  
  logApiRequest('video-play-info', url);
  
  // ★ 关键修改：带上登录后的 Cookie 去请求视频页面
  const cookieStr = await getCookieString('https://www.acfun.cn/');

  const options = {
    headers: {
      ...COMMON_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Cookie': cookieStr
    }
  };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', async () => {
        logApiResponse('video-play-info', res.statusCode);
        try {
          console.log('\n📄 视频页面原始内容片段:', data.substring(0, 500) + '...');

          // 优化 api_st 提取：尝试多种可能的格式
          let apiSt = '';
          let matchSource = '';

          // 尝试从 window.api_st 提取
          const apiStMatch1 = data.match(/window\.api_st\s*=\s*"([^"]+)"/);
          if (apiStMatch1) {
            apiSt = apiStMatch1[1];
            matchSource = 'window.api_st';
          }

          // 尝试从 "api_st" 字段提取
          if (!apiSt) {
            const apiStMatch2 = data.match(/"api_st"\s*:\s*"([^"]+)"/);
            if (apiStMatch2) {
              apiSt = apiStMatch2[1];
              matchSource = '"api_st" 字段';
            }
          }

          // 尝试从 acfun.midground.api_st 提取
          if (!apiSt) {
            const apiStMatch3 = data.match(/acfun\.midground\.api_st\s*=\s*"([^"]+)"/);
            if (apiStMatch3) {
              apiSt = apiStMatch3[1];
              matchSource = 'acfun.midground.api_st';
            }
          }

          // 尝试从 pageInfo 对象提取
          if (!apiSt) {
            const pageInfoMatch = data.match(/window\.pageInfo\s*=\s*({[\s\S]*?});/);
            if (pageInfoMatch) {
              try {
                const pageInfo = JSON.parse(pageInfoMatch[1]);
                apiSt = pageInfo.api_st || pageInfo['acfun.midground.api_st'] || '';
                if (apiSt) matchSource = 'pageInfo 对象';
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
              matchSource = 'HTML中的setCookie调用';
            }
          }
          
          // ★ 新增：直接从当前 session 的 cookie 中获取
          if (!apiSt) {
            const cookies = await session.defaultSession.cookies.get({ url: 'https://www.acfun.cn/' });
            const apiStCookie = cookies.find(c => c.name === 'acfun.midground.api_st');
            if (apiStCookie) {
              apiSt = apiStCookie.value;
              matchSource = 'Session Cookie';
            }
          }

          console.log(`🔑 提取到的 api_st: ${apiSt || '未找到'}`);
          console.log(`📝 匹配来源: ${matchSource || '无匹配'}`);

          const videoInfoMatch = data.match(/window\.videoInfo\s*=\s*({[\s\S]*?});/);
          if (videoInfoMatch) {
            const videoData = JSON.parse(videoInfoMatch[1]);
            console.log('\n📋 videoInfo 结构:', JSON.stringify(Object.keys(videoData), null, 2));
            console.log('📋 videoData.resourceId:', videoData.resourceId);
            console.log('📋 videoData.id:', videoData.id);
            console.log('📋 videoData.currentVideoInfo:', videoData.currentVideoInfo ? JSON.stringify(Object.keys(videoData.currentVideoInfo), null, 2) : 'null');
            if (videoData.currentVideoInfo) {
              console.log('📋 videoData.currentVideoInfo.resourceId:', videoData.currentVideoInfo.resourceId);
              console.log('📋 videoData.currentVideoInfo.id:', videoData.currentVideoInfo.id);
            }
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
                apiSt: apiSt,
                resourceId: videoData.resourceId || videoData.id || (videoData.currentVideoInfo ? videoData.currentVideoInfo.resourceId || videoData.currentVideoInfo.id : '')
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
  
  logApiRequest('comments', url);
  
  const options = { headers: { ...COMMON_HEADERS } };

  return new Promise((resolve, reject) => {
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        logApiResponse('comments', res.statusCode);
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

  logApiRequest('login', url, 'POST', postData);

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
        logApiResponse('login', res.statusCode, data);
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
          console.error('[login] 解析失败:', error.message);
          resolve({ success: false, error: '登录响应解析失败' });
        }
      });
    });

    req.on('error', (error) => {
      console.error('[login] 请求失败:', error.message);
      reject(error);
    });
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
      // 获取额外token
      const tokens = await fetchTokens();
      if (tokens.success) {
        cachedTokens.ssecurity = tokens.ssecurity;
        cachedTokens.api_st = tokens.api_st;
        cachedTokens.api_at = tokens.api_at;
        result.ssecurity = tokens.ssecurity;
        result.api_st = tokens.api_st;
        result.api_at = tokens.api_at;
        console.log('✅ Token已缓存:', cachedTokens);
      }
    }
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ==================== 获取额外token ====================

async function fetchTokens() {
  const url = 'https://id.app.acfun.cn/rest/web/token/get';
  const { hostname, pathname, search } = new URL(url);

  const postData = 'sid=acfun.midground.api';
  
  logApiRequest('tokens', url, 'POST', postData);

  let cookieStr = await getCookieString('https://www.acfun.cn/');
  console.log('🍪 fetchTokens - cookieStr from www.acfun.cn:', cookieStr);
  console.log('🍪 fetchTokens - 完整cookie长度:', cookieStr ? cookieStr.length : 0);

  // 如果 www.acfun.cn 的cookie为空，尝试从 id.app.acfun.cn 获取
  if (!cookieStr || cookieStr.length === 0) {
    cookieStr = await getCookieString('https://id.app.acfun.cn/');
    console.log('🍪 fetchTokens - fallback: cookieStr from id.app.acfun.cn:', cookieStr);
  }

  // 如果都为空，尝试直接使用 loginCookies 对象
  if (!cookieStr || cookieStr.length === 0) {
    cookieStr = Object.entries(loginCookies).map(([k, v]) => `${k}=${v}`).join('; ');
    console.log('🍪 fetchTokens - fallback: 使用 loginCookies 对象:', cookieStr);
  }

  const options = {
    method: 'POST',
    hostname,
    path: pathname + search,
    headers: {
      'accept': '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'cache-control': 'no-cache',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'pragma': 'no-cache',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'Referer': 'https://www.acfun.cn/',
      'Origin': 'https://www.acfun.cn',
      'User-Agent': COMMON_HEADERS['User-Agent'],
      'Cookie': cookieStr,
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      console.log('Token响应状态码:', res.statusCode);
      console.log('Token响应头:', JSON.stringify(res.headers, null, 2));
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        logApiResponse('tokens', res.statusCode, data);
        console.log('Token响应body:', data);
        try {
          const result = JSON.parse(data);
          if (result.result === 0) {
            const token = {
              success: true,
              ssecurity: result.ssecurity,
              api_st: result['acfun.midground.api_st'],
              api_at: result['acfun.midground.api.at']
            };
            console.log('✅ Token提取结果:', token);
            resolve(token);
          } else {
            console.log('❌ Token获取失败 result:', result.result, 'msg:', result.msg);
            resolve({ success: false, error: '获取token失败', raw: result });
          }
        } catch (e) {
          console.log('❌ Token响应解析失败:', e.message);
          resolve({ success: false, error: '解析token响应失败', raw: data });
        }
      });
    });
    req.on('error', (error) => {
      console.log('❌ Token请求网络错误:', error.message);
      resolve({ success: false, error: error.message });
    });
    req.write(postData);
    req.end();
  });
}

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
    
    // 重新获取token
    const tokens = await fetchTokens();
    if (tokens.success) {
      cachedTokens.ssecurity = tokens.ssecurity;
      cachedTokens.api_st = tokens.api_st;
      cachedTokens.api_at = tokens.api_at;
      console.log('✅ 登录状态恢复，Token已重新缓存:', cachedTokens);
    }
    
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

  // 构建请求体
  const body = querystring.stringify({
    kpn: 'ACFUN_APP',
    kpf: 'PC_WEB',
    subBiz: 'mainApp',
    interactType: '1',
    objectType: '2',
    objectId: String(videoId),
    'acfun.midground.api_st': apiSt || cachedTokens.api_st,
    userId: currentUserId,
  }) + '&extParams%5BisPlaying%5D=false&extParams%5BshowCount%5D=1&extParams%5BotherBtnClickedCount%5D=10&extParams%5BplayBtnClickedCount%5D=0';

  logApiRequest('like', url, 'POST', body);

  console.log('\n🔍 点赞请求详情：');
  console.log('📌 接口:', url);
  console.log('🔑 Action:', action);
  console.log('🎯 Video ID:', videoId);
  console.log('📝 请求体:', body);
  console.log('🔑 api_st:', apiSt || cachedTokens.api_st);
  console.log('👤 User ID:', currentUserId);

  // 构建请求头（按照浏览器fetch格式，不包含Cookie和Origin）
  const headers = {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'pragma': 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-storage-access': 'active',
    'Referer': 'https://www.acfun.cn/',
    'User-Agent': COMMON_HEADERS['User-Agent'],
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
        logApiResponse('like', res.statusCode, data);
        console.log('📤 点赞响应:', data);
        try {
          const json = JSON.parse(data);
          if (json.result === 1) { 
            console.log('✅ 点赞成功');
            resolve({ success: true, data: json });
          } else {
            console.log('⚠️ 点赞响应非成功:', json.error_msg || json.result);
            resolve({ success: false, error: json.error_msg || '操作失败', data: json });
          }
        } catch (e) {
          console.log('⚠️ 响应解析失败（非JSON）:', data);
          resolve({ success: false, error: '解析失败', data: data });
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
ipcMain.handle('toggle-like-video', async (event, videoId, isLike) => {
  const action = isLike ? 'add' : 'delete';
  
  // 如果token为空，尝试重新获取
  if (!cachedTokens.api_st) {
    console.log('🔄 Token为空，尝试重新获取...');
    const tokens = await fetchTokens();
    if (tokens.success) {
      cachedTokens.ssecurity = tokens.ssecurity;
      cachedTokens.api_st = tokens.api_st;
      cachedTokens.api_at = tokens.api_at;
      console.log('✅ Token重新获取成功');
    }
  }
  
  // 使用缓存的token
  const apiSt = cachedTokens.api_st;
  
  console.log('🔍 点赞token检查:');
  console.log('  - cachedTokens:', JSON.stringify(cachedTokens));
  console.log('  - apiSt from cache:', apiSt);
  console.log('  - videoId:', videoId);
  console.log('  - action:', action);
  
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

// ==================== 香蕉打赏 ====================

async function sendBanana(videoId, count) {
  const url = 'https://www.acfun.cn/rest/pc-direct/banana/throwBanana';
  const { hostname, pathname, search } = new URL(url);

  const cookieStr = await getCookieString('https://www.acfun.cn/');

  const body = querystring.stringify({
    resourceId: String(videoId),
    count: String(count),
    resourceType: '2',
  });

  logApiRequest('banana', url, 'POST', body);

  console.log('\n🍌 香蕉打赏请求详情：');
  console.log('📌 接口:', url);
  console.log('🎯 Video ID:', videoId);
  console.log('🍌 Count:', count);
  console.log('� 请求体:', body);
  console.log('👤 User ID:', currentUserId);

  const headers = {
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'pragma': 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-requested-with': 'XMLHttpRequest',
    'Referer': `https://www.acfun.cn/v/ac${videoId}`,
    'User-Agent': COMMON_HEADERS['User-Agent'],
    'Cookie': cookieStr,
  };

  return new Promise((resolve) => {
    const req = https.request({
      method: 'POST',
      hostname,
      path: pathname + search,
      headers: headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        logApiResponse('banana', res.statusCode, data);
        console.log('📤 香蕉打赏响应:', data);
        try {
          const json = JSON.parse(data);
          if (json.result === 0) { 
            console.log('✅ 香蕉打赏成功');
            resolve({ success: true, data: json });
          } else {
            console.log('⚠️ 香蕉打赏响应非成功:', json.error_msg || json.result);
            resolve({ success: false, error: json.error_msg || '操作失败', data: json });
          }
        } catch (e) {
          console.log('⚠️ 响应解析失败:', data);
          resolve({ success: false, error: '解析失败', data: data });
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

ipcMain.handle('send-banana', async (event, videoId, count) => {
  const result = await sendBanana(videoId, count);
  return result;
});

// ==================== 弹幕功能 ====================

async function getDanmaku(videoId) {
  const url = 'https://www.acfun.cn/rest/pc-direct/new-danmaku/list';
  const { hostname, pathname } = new URL(url);

  const cookieStr = await getCookieString('https://www.acfun.cn/');

  const body = querystring.stringify({
    resourceId: String(videoId),
    resourceType: 9,
    enableAdvanced: true,
    pcursor: '1',
    count: 200,
    sortType: 1,
    asc: false,
  });

  console.log(`\n🎯 弹幕请求 - 使用的resourceId: ${videoId}`);
  logApiRequest('danmaku', url, 'POST', body);

  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/x-www-form-urlencoded',
    'pragma': 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'Referer': `https://www.acfun.cn/v/ac${videoId}`,
    'User-Agent': COMMON_HEADERS['User-Agent'],
    'Cookie': cookieStr,
  };

  return new Promise((resolve) => {
    const req = https.request({
      method: 'POST',
      hostname,
      path: pathname,
      headers: headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        logApiResponse('danmaku', res.statusCode, data);
        try {
          const json = JSON.parse(data);
          if (json.result === 0) {
            resolve({ success: true, danmakus: json.danmakus || [], totalCount: json.totalCount || 0 });
          } else {
            resolve({ success: false, error: json.error_msg || '获取弹幕失败', data: json });
          }
        } catch (e) {
          resolve({ success: false, error: '解析失败', data: data });
        }
      });
    });
    req.on('error', (e) => {
      resolve({ success: false, error: e.message });
    });
    req.write(body);
    req.end();
  });
}

ipcMain.handle('get-danmaku', async (event, videoId) => {
  const result = await getDanmaku(videoId);
  return result;
});

// ==================== 个人空间功能 ====================

async function getSpacePage() {
  const url = 'https://www.acfun.cn/u/67120110';
  const { hostname, pathname } = new URL(url);

  const cookieStr = await getCookieString('https://www.acfun.cn/');

  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'User-Agent': COMMON_HEADERS['User-Agent'],
    'Cookie': cookieStr,
  };

  console.log(`\n🎯 个人空间请求 - URL: ${url}`);

  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET',
      hostname,
      path: pathname,
      headers: headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        console.log(`📋 个人空间响应: ${res.statusCode}`);
        if (res.statusCode === 200) {
          resolve({ success: true, html: html });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on('error', (e) => {
      resolve({ success: false, error: e.message });
    });
    req.end();
  });
}

function openVideoWindow(videoId) {
  const videoWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  videoWindow.loadFile(path.join(__dirname, 'video.html'), {
    query: { video: JSON.stringify({ videoId: videoId }) }
  });
}

ipcMain.handle('get-space-page', async () => {
  const result = await getSpacePage();
  return result;
});

ipcMain.handle('open-space', async () => {
  const spaceWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  spaceWindow.loadFile(path.join(__dirname, 'space.html'));

  spaceWindow.webContents.on('will-navigate', (event, url) => {
    const match = url.match(/https:\/\/www\.acfun\.cn\/v\/ac(\d+)/);
    if (match) {
      event.preventDefault();
      const videoId = match[1];
      console.log(`🎬 拦截视频链接: ac${videoId}`);
      openVideoWindow(videoId);
    }
  });

  spaceWindow.webContents.setWindowOpenHandler(({ url }) => {
    const match = url.match(/https:\/\/www\.acfun\.cn\/v\/ac(\d+)/);
    if (match) {
      const videoId = match[1];
      console.log(`🎬 拦截视频新窗口: ac${videoId}`);
      openVideoWindow(videoId);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  spaceWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const match = details.url.match(/https:\/\/www\.acfun\.cn\/v\/ac(\d+)/);
    if (match) {
      console.log(`🎬 WebRequest拦截视频请求: ac${match[1]}`);
      openVideoWindow(match[1]);
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  });

  return true;
});

// ==================== 调试信息转发 ====================

ipcMain.on('video-debug-info', (event, info) => {
  console.log('📱 视频页面调试信息:', info);
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(window => {
    if (window.webContents.getURL().includes('index.html')) {
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

// 调试：跳转到指定视频
ipcMain.handle('goto-video', async (event, videoId) => {
  if (videoId.startsWith('ac')) {
    videoId = videoId.substring(2);
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    window.webContents.send('goto-video', videoId);
  }
  return { success: true, videoId: videoId };
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
