// 图鉴（Handbook）系统：正式/联动/皮肤/灵契/狂化五类图鉴 + 羁绊剧情奖励 + 点赞。
// 剧情图鉴（TYPE_THEATER）走 TheaterMgr（m_theatre_info_toc，见 role.js/activity.js），不在此文件。
//
// 客户端机制（tools/bc_cmp/handbook_new/ 反编译实证）：
// - 列表入口 m_role_handbook_info_tos → toc{servants:[p_handbook_brief], num, num2}：
//   brief.id=图鉴 servantType（狂化=100000000+本体）、star>0 即"已激活"（HandbookMgr.initActive）；
//   num/num2 = 正式/联动图鉴总数（"契约收集 x/num"分母，chinese_s 语言口径）。
// - 详情 m_role_handbook_detail_tos{servants_type_id} → toc：star/feeling/gain_time/cv_list(已解锁语音)/
//   first_cv_list(新语音)/tips_list(私密 p_kvt type:1可解锁/2已解锁)/mv_list(羁绊剧情 p_mv state:1锁/2激活/
//   3可领/4已领)/like_num/is_like/tags(前4标签)/red_point。语音/私密/羁绊的官方解锁条件（羁绊值/突破）依赖
//   未实现的羁绊系统（funcID 10）——本地服口径：激活即全解锁（tips type=2、cv 全开、mv 直接可领取）。
// - 皮肤图鉴列表不在 CfgHandbook：m_item_skin_handbook_info_toc(主题)/m_pledge_skin_handbook_info_toc(灵契)
//   全量下发 p_item_skin/p_pledge_skin；客户端按收到的 skin_id 建 VO（HandbookMgr.updateHandbookSkin）。
//   unlock：1=已拥有皮肤 3=有誓灵未得皮肤 0=都没有（isOwnSkin=unlock==1, isHasServant=unlock==1||3）。
// - 点赞/红点：m_handbook_(un)like_toc{servant_type,tag,num}（tag=0 整体点赞，客户端不消费回包）；
//   m_skin_handbook_(un)like_toc{skin_id,like_num}；新解锁推 m_role_handbook_red_point_toc{num,berserk_num}
//   与 m_skin_handbook_red_point_toc{theme_num,marry_num}（客户端只在 info 重拉/切页签时本地清零，
//   服务端须在对应 info_tos 里补推 0 清除）。
// - 狂化（FUNC_ID_DARK=17 未实现）：图鉴条目仍可激活展示（L2D 开关/btnBerserk 被 isFuncOpen(17) 隐藏，
//   不影响列表与详情）；激活口径=拥有本体誓灵。
const { S, saveState } = require('../state');
const L = require('../lib');
const D = require('../data/handbook_data');
const R = require('../data/feeling_rules');
const F = require('./feeling');
const log = require('../log').log;

// ---- 确定性点赞基数（单机本地服无社交数据：以 typeId/skinId 散列出稳定值，玩家点赞 ±1 持久化） ----
function h32(x) {
  let n = (Number(x) ^ 0x9e3779b9) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 2246822507) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 3266489909) >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}
const baseLikeOf = typeId => 50 + h32(typeId * 7 + 1) % 900;          // 誓灵整体点赞数
const tagLikeOf = (typeId, tag) => 3 + h32(typeId * 131 + tag * 17 + 2) % 280; // 单标签点赞数
const skinLikeOf = skinId => 20 + h32(skinId * 13 + 3) % 600;          // 皮肤点赞数

// ---- 每誓灵的标签集（官方为社区数据不可考：从 34 个标签里按 typeId 散列稳定取 8 个，去重补齐） ----
function tagsOfType(typeId) {
  const n = D.TAGS.length;
  const seen = new Set();
  const out = [];
  for (let i = 0; out.length < 8 && i < n * 4; i++) {
    const t = D.TAGS[(h32(typeId * 31 + i * 5 + 11) + i * 3) % n];
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// ---- 懒初始化 + 旧档回填：已拥有誓灵 ⇒ 图鉴激活（含狂化派生） ----
function st() {
  if (!S.handbookState) {
    S.handbookState = { actives: {}, likes: {}, skinLikes: {}, mvGot: {}, tipsUnlocked: {}, unseen: [], skinUnseen: { theme: [], marry: [] } };
  }
  const hs = S.handbookState;
  if (!hs.actives) hs.actives = {};
  if (!hs.likes) hs.likes = {};
  if (!hs.skinLikes) hs.skinLikes = {};
  if (!hs.mvGot) hs.mvGot = {};
  if (!hs.tipsUnlocked) hs.tipsUnlocked = {}; // {图鉴type: [已解锁的私密条目 id]}（羁绊门槛 30/60/80）
  if (!Array.isArray(hs.unseen)) hs.unseen = [];
  if (!hs.skinUnseen) hs.skinUnseen = { theme: [], marry: [] };
  if (!Array.isArray(hs.skinUnseen.theme)) hs.skinUnseen.theme = [];
  if (!Array.isArray(hs.skinUnseen.marry)) hs.skinUnseen.marry = [];
  return hs;
}

// 获得誓灵 ⇒ 激活图鉴（含狂化派生条目）。幂等；返回是否有新激活
function onServantObtained(type, gainTime) {
  const hs = st();
  let changed = false;
  const activate = id => {
    if (D.BY_TYPE[id] && !hs.actives[id]) {
      hs.actives[id] = Math.floor((gainTime || Date.now()) / 1000);
      if (!hs.unseen.includes(id)) hs.unseen.push(id);
      changed = true;
    }
  };
  activate(Number(type));
  const berserk = D.BERSERK_OF[Number(type)];
  if (berserk) activate(berserk);
  return changed;
}

// 图鉴是否已激活该 type（含狂化派生联动激活；誓约破除/分解不回退）。
// is_first/NEW 角标的唯一权威口径：图鉴开了就不应该再 NEW——与客户端图鉴列表
// （m_role_handbook_info_toc.servants → HandbookMgr.initActive）同源。
// ⚠️ 必须在 makeServantBrief 之前调用：其内部会 onServantObtained 激活图鉴（先判后建卡）
function isUnlocked(type) {
  return !!st().actives[Number(type)];
}

// 旧档回填：当前拥有的全部誓灵类型补激活（gain_time 取誓灵自身获得时间）
function backfill() {
  const hs = st();
  const before = Object.keys(hs.actives).length;
  for (const b of S.servants) onServantObtained(b.type, b.gain_time);
  const added = Object.keys(hs.actives).length - before;
  if (added) { log(`[handbook] 旧档回填：补激活 ${added} 条图鉴（含狂化派生）`); saveState(); }
}

// star=该类型最高实例星级（客户端 getStep(star) 选进化立绘）；无实例回落 2 = 官方出生星级，
// 也是皮肤列表第 1 档，索引恒安全。进化升星后图鉴条目自动换成对应阶的进化立绘
// 该类型全部实例的最高羁绊值（图鉴按 servantType 聚合，玩家可能持有多只同名誓灵）
function feelingOf(typeId) {
  let f = 0;
  for (const b of S.servants) if (b.type === typeId && (Number(b.feeling) || 0) > f) f = Number(b.feeling) || 0;
  return f;
}

// 详情红点（HandbookVO：id=1 私密页、id=2 羁绊页）：有"够羁绊但还没点解锁"的私密条目、
// 或有"够羁绊但没领奖"的小剧场，就亮对应页签
function redPointsOf(id, base, feeling, unlocked) {
  const hs = st();
  const got = hs.mvGot[id] || [];
  const tipsRed = (D.PRIVATE[base] || []).some(p => feeling >= p.val && !unlocked.includes(p.id));
  const mvRed = (D.FEELING[base] || []).some(f => feeling >= f.val && !got.includes(f.id));
  const out = [];
  if (tipsRed) out.push({ id: 1, val: 1 });
  if (mvRed) out.push({ id: 2, val: 1 });
  return out;
}

function starOf(typeId) {
  let star = 0;
  for (const b of S.servants) if (b.type === typeId && b.star > star) star = b.star;
  return star || 2;
}

function likedOf(typeId, tag) {
  const hs = st();
  return !!(hs.likes[typeId] && hs.likes[typeId][tag]);
}
function setLiked(typeId, tag, on) {
  const hs = st();
  if (on) { (hs.likes[typeId] = hs.likes[typeId] || {})[tag] = 1; }
  else if (hs.likes[typeId]) delete hs.likes[typeId][tag];
}
function likeNumOf(typeId, tag) {
  const base = tag === 0 ? baseLikeOf(typeId) : tagLikeOf(typeId, tag);
  return base + (likedOf(typeId, tag) ? 1 : 0);
}

// 红点推送：新激活的图鉴条目数。schema 只有 num 一个字段（客户端 handler 虽读 berserk_num
// 但 Proto 无该字段解码恒 nil——把狂化计数并入 num，保证徽标点亮）
function pushRedPoints(conn) {
  const hs = st();
  conn.sendToc('m_role_handbook_red_point_toc', { num: hs.unseen.length });
}
function pushSkinRedPoints(conn) {
  const hs = st();
  conn.sendToc('m_skin_handbook_red_point_toc', { theme_num: hs.skinUnseen.theme.length, marry_num: hs.skinUnseen.marry.length });
}

// 皮肤获得钩子（shop.js 购买激活 / GM）：记录 is_new + 红点
function onSkinObtained(skinId) {
  const hs = st();
  const t = D.THEME_SKINS.find(s => s.skin === Number(skinId));
  const m = !t && D.MARRY_SKINS.find(s => s.skin === Number(skinId));
  if (!t && !m) return false;
  const key = t ? 'theme' : 'marry';
  if (!hs.skinUnseen[key].includes(Number(skinId))) hs.skinUnseen[key].push(Number(skinId));
  return true;
}

// ---- 卫星名单下发口径（m_role_handbook_filter_toc）----
// 客户端 HandbookMgr.getFilterList（bc 双源实证：lua_src 与 bc_cmp/handbook_new 同一行）对名单内
// type **无条件剔除**——誓灵背包按 属性/阵营/稀有度 筛选时"获得的誓灵检索不到"（解慕漱工单），
// 图鉴条目剪影 + 点击/点赞拦截（"还在卫星上~"）同源。名单本身照抄官方 CfgHandbook.waitHandbooks
// （extract_handbook.js 生成），但本服已把其中 4 只实装进投放面（gen_summon_data.py 的全量名册
// 只排了无立绘的 ARTLESS，没排卫星）：
//   解慕漱 2545001（池39/102 UP + 回响兑换）/ 高朱蒙 2541002（池39 + 回响兑换）/
//   阿努比斯 1636003、伊里丝 1423032（普通池名册，真实档已实际抽出）
// 蛟 1521014 / 乌列尔 1144022 = gen_summon_data.py ARTLESS_SERVANT_TYPES（卡面/头像/spine 全缺、
// 无任何投放渠道）→ 保持卫星。
// 口径 = 名单 ∩ (不在任何投放面) ∩ (该玩家未持有)。"已持有必解除"：客户端 VO 的 nature/color 由
// typeId 数位推导，与名单无关——名单是筛选面唯一的排除源，所以已获得（含 GM 发放的蛟/乌列尔）
// 必须可检索。若未来把卫星实装进商店/协作等新投放面，记得同步加进这里的扫描（投放面扩清单）。
function satelliteWaitListFor(ownedTypes) {
  const obtainable = new Set();
  const SUMMON = require('../data/summon_data');   // 懒加载：数据文件互相独立，防 require 环
  const ECHO = require('../data/echo_shop_data');
  for (const p of SUMMON.POOLS) for (const t of (p.special || [])) obtainable.add(Number(t));
  for (const list of Object.values(SUMMON.POOL_CONTENTS)) {
    for (const e of list) {
      const t = Number(e.id) - 30000000;           // 池内容 = [{id: 30000000+type, val}]（summon_rules 同式）
      if (t > 999999 && t < 10000000) obtainable.add(t);
    }
  }
  for (const s of ECHO.SERVANTS) obtainable.add(Number(s.type));
  return D.WAIT_HANDBOOKS.filter(t => !obtainable.has(t) && !ownedTypes.has(t));
}

// ---- 登录推送：卫星名单（m_role_handbook_filter_toc）+ 待查看红点 ----
function onLogin(conn) {
  backfill();
  const hs = st();
  const ownedTypes = new Set((S.servants || []).map(v => Number(v.type)));
  setTimeout(() => conn.sendToc('m_role_handbook_filter_toc', { servants: satelliteWaitListFor(ownedTypes) }), 2500);
  setTimeout(() => {
    if (hs.unseen.length) pushRedPoints(conn);
    if (hs.skinUnseen.theme.length || hs.skinUnseen.marry.length) pushSkinRedPoints(conn);
  }, 2600);
}

// ---- 羁绊剧情奖励发放：30000000 水晶/30000003 金币走货币，道具形态积分落 role_scores，
//      其余入包（与任务奖励同口径） ----
function grantReward(conn, typeId, num) {
  if (typeId === 30000000) {
    S.roleAsset.gold += num; S.roleAsset.gold_given += num;
    L.pushAssetChange(conn);
  } else if (typeId === 30000003) {
    S.roleAsset.silver += num;
    L.pushAssetChange(conn);
  } else if (L.grantScoreItem(conn, typeId, num)) {
    // 已落 role_scores 并推送 m_role_score_change_toc
  } else {
    const changed = L.grantGoods(typeId, num, conn);
    if (changed.length) L.pushGoodsUpdate(conn, changed, 3); // 显式 3=GOODS_OP_UPDATE（数组会编码成 0 的前车之鉴）
  }
}

// 图鉴条目（狂化 → 本体）解析：[brief 用的 id, 配置查表用的本体 id]
function resolve(id) {
  id = Number(id) || 0;
  const base = id > 100000000 ? id - 100000000 : id;
  return [id, base];
}

module.exports = {
  handlers: {
    // ---- 列表：全部已激活条目 brief + 分类总数；顺带清红点（客户端只在 info 重拉时展示，不清会常亮） ----
    m_role_handbook_info_tos(conn) {
      const hs = st();
      const servants = Object.keys(hs.actives)
        .map(Number)
        .filter(id => D.BY_TYPE[id])
        .map(id => ({
          id,
          star: starOf(id > 100000000 ? id - 100000000 : id), // 狂化条目星级取本体实例
          like_num: likeNumOf(id, 0),
          is_like: likedOf(id, 0) ? 1 : 0,
          red_point: [],
        }));
      conn.sendToc('m_role_handbook_info_toc', { servants, num: D.COUNT_NORMAL, num2: D.COUNT_INTER });
      if (hs.unseen.length) { hs.unseen = []; saveState(); }
      conn.sendToc('m_role_handbook_red_point_toc', { num: 0 });
    },

    // ---- 详情：语音全开 / 私密与羁绊剧情按**羁绊值**门槛解锁（未激活条目回最小包） ----
    // 羁绊值取该类型全部实例的最高值（图鉴是按 servantType 聚合的，玩家可能有多只同名）。
    // tips_list（私密信息 3 条，门槛 feeling 30/60/80）：p_kvt 的语义容易记错——
    //   **val = 当前羁绊值（进度）**，不是门槛！客户端 HandbookPrivateItem 把它填进
    //   "解锁条件:羁绊值({0}/{1})" 的 {0}，{1} 才是配置里的门槛（CfgHandbook.private.val）。
    //   type = HandbookVO 的 LOCK_STATE：1 可解锁（够羁绊但没点解锁）/ 2 已解锁；其余值 = 仍锁着。
    //   点击可解锁条目发 m_handbook_unlock_tips_tos{servant_type} → 一次解锁**全部**够门槛的条目。
    // mv_list（小剧场 3 个，门槛 feeling 20/50/100）：state 1 未达成 / 3 可领取 / 4 已领取，
    //   cur_progress = [当前羁绊, 门槛]（客户端填进"羁绊值达到({0}/{1})"）。
    m_role_handbook_detail_tos(conn, obj) {
      const hs = st();
      const [id, base] = resolve(obj && obj.servants_type_id);
      const active = !!hs.actives[id];
      const feels = active ? (D.FEELING[base] || []) : [];
      const got = hs.mvGot[id] || (hs.mvGot[id] = []);
      const feeling = active ? feelingOf(base) : 0;
      const unlocked = hs.tipsUnlocked[id] || (hs.tipsUnlocked[id] = []);
      conn.sendToc('m_role_handbook_detail_toc', {
        servants_type_id: id,
        star: active ? starOf(base) : 2,
        feeling,
        gain_time: hs.actives[id] || 0,
        cv_list: active ? (D.DIALOGUE[base] || []) : [],        // lockType!=0 的语音全解锁（语音触发条件太杂，见文末注）
        first_cv_list: [],
        tips_list: active ? (D.PRIVATE[base] || []).map(p => ({
          id: p.id,
          val: feeling,                                        // 当前羁绊（进度），门槛在客户端配置里
          type: unlocked.includes(p.id) ? 2 : (feeling >= p.val ? 1 : 0),
        })) : [],
        mv_list: feels.map(f => ({
          mv_id: f.id,
          state: got.includes(f.id) ? 4 : (feeling >= f.val ? 3 : 1),
          cur_progress: [feeling, f.val],
        })),
        like_num: likeNumOf(id, 0),
        tags: active ? tagsOfType(base).slice(0, 4) : [],
        is_like: likedOf(id, 0) ? 1 : 0,
        red_point: redPointsOf(id, base, feeling, unlocked),
      });
    },

    // ---- 播放语音上报（客户端 HandbookModule.toPlayCv）----
    // 平时只是"这条我听了"，**没有同名 toc**；原实现走 start.js 的 fallbackHandler → 每点一次语音
    // 就在服务端打一条 `?? 无处理器: m_role_handbook_play_cv_tos`（2026-09-12 日志实证），纯噪音。
    // ★ 触摸涨羁绊复用这条上报：客户端补丁给大厅主页面立绘点击额外发 play_type=3
    //   （client/Modules/main/MainModuleAutoGen.lua 的运行时补丁），其余调用方仍是 2。
    //   结算在 feeling.touchFeeling（判定/数值/每日上限/冷却），这里只负责转交与回包。
    // ⚠️ 无论是否计入都必须回 m_common_reply_toc：客户端发完 play_cv 收不到包会显示 loading
    //   并触发重连循环（参考实现真机踩过两次）；本协议没有同名 toc，通用回复正是为它设计的。
    m_role_handbook_play_cv_tos(conn, obj) {
      try {
        F.touchFeeling(conn, obj);
      } catch (e) {
        log(`[handbook] 触摸结算异常（不阻塞回包）：${e.message}`);
      }
      conn.sendToc('m_common_reply_toc', { proto_id: 0 });
    },
    // ---- 解锁私密信息（点击"可解锁"条目）：一次解锁全部够羁绊门槛的条目 ----
    // 客户端 HandbookVO.unlockAllCanUnlock 把所有 type=1 的改成 2，服务端要落账否则重开面板又变回可解锁
    m_handbook_unlock_tips_tos(conn, obj) {
      const hs = st();
      const [id, base] = resolve(obj && obj.servant_type);
      const feeling = feelingOf(base);
      const unlocked = hs.tipsUnlocked[id] || (hs.tipsUnlocked[id] = []);
      const news = (D.PRIVATE[base] || []).filter(p => feeling >= p.val && !unlocked.includes(p.id));
      if (!news.length) {
        conn.sendToc('m_common_reply_toc', { proto_id: 0 });
        log(`[handbook] 私密解锁：无可解锁条目 type=${id}（羁绊 ${feeling}）`);
        return;
      }
      news.forEach(p => unlocked.push(p.id));
      saveState();
      conn.sendToc('m_handbook_unlock_tips_toc', { servant_type: id });
      log(`[handbook] 私密解锁 type=${id} 羁绊${feeling} → 解锁 ${news.map(p => `#${p.id}(需${p.val})`).join(' ')}`);
    },

    // ---- 羁绊剧情激活（客户端点击可激活条目）：回显 toc（mvDic 已有条目，客户端置 CAN_GET） ----
    m_handbook_active_mv_tos(conn, obj) {
      const [id, base] = resolve(obj && obj.servant_type);
      const mvId = Number(obj && obj.mv_id) || 0;
      const ok = (D.FEELING[base] || []).some(f => f.id === mvId);
      if (ok) conn.sendToc('m_handbook_active_mv_toc', { servant_type: id, mv_id: mvId });
      else conn.sendToc('m_common_reply_toc', { proto_id: 0 }); // 未知条目回显会让客户端 mvDic[mv_id]=nil 崩
    },

    // ---- 羁绊剧情领奖：发配置奖励（多为水晶）+ 置 GET ----
    m_handbook_mv_reward_tos(conn, obj) {
      const hs = st();
      const [id, base] = resolve(obj && obj.servant_type);
      const mvId = Number(obj && obj.mv_id) || 0;
      const cfg = (D.FEELING[base] || []).find(f => f.id === mvId);
      if (!cfg) { conn.sendToc('m_common_reply_toc', { proto_id: 0 }); return; }
      // 羁绊门槛（官方错误码 425001「条件未达成」）：客户端本来也点不到未达成的条目，这里防脱钩
      if (feelingOf(base) < cfg.val) {
        conn.sendToc('m_common_error_toc', { code: 425001 });
        log(`[handbook] 羁绊剧情领奖被拒（425001）type=${id} mv=${mvId}：羁绊 ${feelingOf(base)}/${cfg.val}`);
        return;
      }
      const got = hs.mvGot[id] || (hs.mvGot[id] = []);
      if (!got.includes(mvId)) {
        got.push(mvId);
        grantReward(conn, cfg.item, cfg.num);
        saveState();
        log(`[handbook] 羁绊剧情领奖 type=${id} mv=${mvId} → ${cfg.item}×${cfg.num}`);
      }
      conn.sendToc('m_handbook_mv_reward_toc', { servant_type: id, mv_id: mvId });
    },

    // ---- 标签列表（打开标签面板时拉取） ----
    m_handbook_tags_tos(conn, obj) {
      const [id, base] = resolve(obj && obj.servant_type);
      conn.sendToc('m_handbook_tags_toc', {
        servant_type: id,
        tags: tagsOfType(base).map(t => ({ id: t, val: likeNumOf(id, t), type: likedOf(id, t) ? 1 : 0 })),
      });
    },

    // ---- 点赞 / 取消（tag=0 整体；客户端 tag!=0 才消费回包 num） ----
    m_handbook_like_tos(conn, obj) {
      const [id] = resolve(obj && obj.servant_type);
      const tag = Number(obj && obj.tag) || 0;
      setLiked(id, tag, true); saveState();
      conn.sendToc('m_handbook_like_toc', { servant_type: id, tag, num: likeNumOf(id, tag) });
    },
    m_handbook_unlike_tos(conn, obj) {
      const [id] = resolve(obj && obj.servant_type);
      const tag = Number(obj && obj.tag) || 0;
      setLiked(id, tag, false); saveState();
      conn.sendToc('m_handbook_unlike_toc', { servant_type: id, tag, num: likeNumOf(id, tag) });
    },

    // ---- 皮肤图鉴（主题）：全量下发 162 件主题皮肤 ----
    m_item_skin_handbook_info_tos(conn) {
      const hs = st();
      const owned = new Set(S.skinState.owned.map(Number));
      const hasServant = t => S.servants.some(b => b.type === t);
      const shop = require('../data/shop_data').SKIN_GOODS;
      const goods = new Map(shop.map(g => [Number(g.skin_id), g.id])); // 在售商品 id（isOnSell/跳转购买）
      const info = D.THEME_SKINS.map(s => ({
        skin_id: s.skin,
        like: hs.skinLikes[s.skin] ? 1 : 0,
        like_num: skinLikeOf(s.skin) + (hs.skinLikes[s.skin] ? 1 : 0),
        unlock: owned.has(s.skin) ? 1 : (hasServant(s.type) ? 3 : 0),
        sell_id: goods.get(s.skin) || 0,
        is_new: hs.skinUnseen.theme.includes(s.skin) ? 1 : 0,
      }));
      conn.sendToc('m_item_skin_handbook_info_toc', { info });
      hs.skinUnseen.theme = []; saveState();
    },

    // ---- 皮肤图鉴（灵契）：全量下发 15 件灵契皮肤 ----
    // unlock=1 已解锁：GM m21_skin 静态解锁 或 该 type 已缔结灵契（lib.isTypeMarried 派生，
    //   与皮肤面板 priv_skin 下发同口径）；3=有誓灵未缔结（客户端 NotMarryIcon"未缔结灵契"遮罩）；
    //   0=无誓灵（NotGetIcon）。feeling=该 type 最高羁绊（HandbookSkinVO.topFeeling，
    //   当前无渲染消费方，发真实值保语义正确）。
    m_pledge_skin_handbook_info_tos(conn) {
      const hs = st();
      const owned = new Set(S.skinState.owned.map(Number));
      const hasServant = t => S.servants.some(b => b.type === t);
      const topFeelingOf = t => Math.max(0, ...S.servants.filter(b => b.type === t).map(R.feelingOf));
      const info = D.MARRY_SKINS.map(s => ({
        skin_id: s.skin,
        like: hs.skinLikes[s.skin] ? 1 : 0,
        like_num: skinLikeOf(s.skin) + (hs.skinLikes[s.skin] ? 1 : 0),
        unlock: (owned.has(s.skin) || L.isTypeMarried(s.type)) ? 1 : (hasServant(s.type) ? 3 : 0),
        feeling: topFeelingOf(s.type),
        is_new: hs.skinUnseen.marry.includes(s.skin) ? 1 : 0,
      }));
      conn.sendToc('m_pledge_skin_handbook_info_toc', { info });
      hs.skinUnseen.marry = []; saveState();
    },

    // ---- 皮肤点赞 / 取消 ----
    m_skin_handbook_like_tos(conn, obj) {
      const hs = st();
      const skin = Number(obj && obj.skin_id) || 0;
      hs.skinLikes[skin] = 1; saveState();
      conn.sendToc('m_skin_handbook_like_toc', { skin_id: skin, like_num: skinLikeOf(skin) + 1 });
    },
    m_skin_handbook_unlike_tos(conn, obj) {
      const hs = st();
      const skin = Number(obj && obj.skin_id) || 0;
      delete hs.skinLikes[skin]; saveState();
      conn.sendToc('m_skin_handbook_unlike_toc', { skin_id: skin, like_num: skinLikeOf(skin) });
    },

    // ---- 点击皮肤条目 → 换装预览弹窗：在售皮肤带商店货（可购买），未在售只回空（客户端走预览兜底） ----
    m_skin_shop_detail_tos(conn, obj) {
      const skin = Number(obj && obj.skin_id) || 0;
      const opType = Number(obj && obj.op_type) || 0;
      const def = require('../data/shop_data').SKIN_GOODS.find(g => Number(g.skin_id) === skin);
      const detail = def ? [require('./shop').itemP(def)] : [];
      conn.sendToc('m_skin_shop_detail_toc', { skin_id: skin, detail, op_type: opType });
    },
  },

  onServantObtained, onSkinObtained, onLogin, pushRedPoints, pushSkinRedPoints, backfill, st, isUnlocked,
  satelliteWaitListFor, // 冒烟用：卫星名单下发口径（解慕漱筛选消失工单）
};
