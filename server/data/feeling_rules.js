// 羁绊（feeling）系统规则与本地服数值——纯函数，无副作用。
//
// 客户端口径（tools/bc_cmp/ServantFeelVO_re.lua 等实证，见 data/feeling_data.js 头注）：
//   feeling      当前羁绊值，未婚上限 100 / 已缔结灵契 200
//   satisfaction 升下一点羁绊的进度条 0~100，满 100 → feeling+1、satisfaction-=100（可连升）
//   feeling_record 里程碑时间戳 [{id: 里程碑值, val: unix秒}]，只写 50/100 两格
//                （0 格客户端读 type_gain_time、101 格读 pledge_time）
//   pledge_time>0 才算已缔结灵契（客户端从不读 pledge 字段）
//
// 【本地服设计值】客户端**完全没有**下面这些数字（送礼涨多少、战斗涨羁绊的概率与上限、心愿怎么生成），
// 官方数值随停服不可考，这里是本服基线，集中放在本文件便于调参。
const FD = require('./feeling_data');

// ---- 送礼 ----
// 单次送礼的 satisfaction 增量按礼物品质（CfgItems.color：3 蓝 / 4 紫 / 5 金）分档。
// 命中心愿再乘倍率：NORMAL（客户端会在礼物上打爱心，好找）×2；MISTERY（只给文字暗示，难猜）×3。
// 参考节奏：紫礼物命中普通心愿 = 150×2 = 300 satisfaction = 3 点羁绊；
//   休息室 2 位 → 每日 4 次送礼 → 约 12 点/天，0→100 约 9 天；6 位满解锁则约 3 天。
const SATISFACTION_BY_COLOR = { 3: 75, 4: 150, 5: 400 };
const SATISFACTION_DEFAULT = 75;          // 未登记 color 的兜底
const WISH_MUL = { 1: 2, 2: 3 };          // DormConst.WISH_TYPE_NORMAL=1 / MISTERY=2
const GIFT_TIMES_PER_SLOT = 2;            // DormMgr.getMaxSendTime() = 休息室槽位数 × 2（客户端硬口径）

// ---- 战斗涨羁绊 ----
// 客户端台词原文「(出战可概率增加羁绊值)」，但概率/数量/上限客户端一个字都没有 → 全自定。
// 口径：主线**整关通关**（BOSS 点）时，本关出战过的誓灵各自独立掷骰。
// 活动 id 201（CopyConst.DROP_ACT_FEEL_15）生效期间概率 ×1.5，客户端会显示「增加羁绊值概率1.5倍」。
const BATTLE_CHANCE = 0.4;                // 每只每关 40% 命中
const BATTLE_GAIN = 25;                   // 命中一次 +25 satisfaction
const BATTLE_DAILY_CAP = 300;             // 每只每天战斗途径最多 +300 satisfaction（= 3 点羁绊）
const ACT_FEEL_MUL_ID = 201;              // CopyConst.DROP_ACT_FEEL_15
const ACT_FEEL_MUL = 1.5;

// ---- 立绘触摸涨羁绊（大厅主页面触摸好感）----
// 客户端没有专用协议：触摸复用图鉴语音上报 m_role_handbook_play_cv_tos{servant_type_id, cv_id, play_type}。
// 场景判据 = **客户端补丁标记** play_type=3：client/Modules/main/MainModuleAutoGen.lua 的运行时补丁只给
//   MainFunctionPanel:onCardClick 里那次 playCv 追加一条直发（play_type=3）；图鉴/详情/养成/战斗等
//   其余调用方仍是 2 ⇒ 服务端只认 3 即等价于「仅大厅主页面立绘触摸」。
// cv_id 2..12 = 立绘对话索引域（cardSet.cvs/highCvs/times/touchs 全在此域；13+ 是战斗/养成/系统语音）。
// 口径（沿用参考实现 Python 版的定稿口径，2026-09-24）：
//   · 每次 +5 satisfaction，进**与送礼共用**的池子（客户端进度条可见，两边都照常累加）；
//   · **不因进位而停**：进位照常发生，进位后继续摸照常给（上限是"当天累计"而不是"进位就关"）；
//   · 每日全账号 20 次硬顶 + 30 秒全账号冷却（只对"计入"的触摸生效，冷却中不写状态/不耗次数）；
//   · 每日触摸贡献的 satisfaction ≤ 100（= SATISFACTION_PER_POINT × 1，数字口径：最多 1 点羁绊）；
//   · 羁绊已满（未婚 100 / 誓约后 200）⇒ 直接不计，不耗次数。
// 数值客户端零配置（触摸涨多少/上限/冷却全在服务端），与送礼/战斗涨羁绊先例一样集中在本文件便于调参。
const TOUCH_PLAY_TYPE = 3;         // 3 = 大厅主页面立绘触摸（客户端补丁标记）；2 = 其它立绘语音
const TOUCH_LEGACY_PLAY_TYPE = 2;  // 旧客户端/其它调用方；服务端**不**据它计数
const TOUCH_CV_MIN = 2;            // 立绘对话索引下界
const TOUCH_CV_MAX = 12;           // 立绘对话索引上界（13+ = 战斗/养成/系统语音）
const TOUCH_SATISFACTION = 5;      // 每次触摸 +5 satisfaction（进**共用**池）
const TOUCH_DAILY_LIMIT = 20;      // 每日触摸次数上限（全账号共享）
const TOUCH_DAILY_FEELING_CAP = 1; // 每日触摸产出的羁绊值上限（数字口径，全账号共享）
const TOUCH_COOLDOWN_SEC = 30;     // 两次"计入"的触摸至少间隔 30 秒（全账号共享；0 = 关闭冷却）

// ---- 灵契 ----
const PLEDGE_NEED_FEELING = FD.FEELING_MAX; // 100（官方错误码 666003「与誓灵的羁绊值不足」）
const RENAME_CD_DAYS = 30;                  // 客户端 ServantFeelView 本地也算 30 天改名 CD

// 官方错误码（CfgErrorCode，按对应 toc 的 protoId 编号）
const ERR = {
  GIFT_TIMES: 679001,    // 送礼次数不足
  GIFT_NUM: 679002,      // 礼物数量不足
  FEELING_FULL: 679003,  // 羁绊值已满
  PLEDGE_ITEM: 666001,   // 结缔灵契道具不足
  PLEDGE_DONE: 666002,   // 已与该誓灵缔结灵契
  PLEDGE_FEELING: 666003, // 与誓灵的羁绊值不足
  PLEDGE_BUSY: 666004,   // 誓灵跑出去了（出战/派遣中）
  MSG_LONG: 673001,      // 寄语过长
  MSG_NO_PLEDGE: 673002, // 未与誓灵缔结灵契
  NAME_NO_PLEDGE: 675001, // 缔结灵契后可修改誓灵昵称
  NAME_CD: 675002,       // 改名冷却中
  NAME_DUP: 675003,      // 你已经有誓灵使用这个名字了
  DORM_NO_SERVANT: 1100002, // 誓灵不存在
  DORM_NOT_FULL: 1100003,   // 该誓灵的羁绊值未满
  PARAM: 156001,         // 参数错误
};

// ---- 休息位自动上涨（二百七十四）：满足度增速 + 誓灵收集（小惊喜）----
// —— 官方口径（实证）——
// 满足度增速表 = CfgHouse.satisfy 原文，消费式 HouseConfig.getSatisfy(prosperity)：
//   返回第一个「繁荣度 ≤ 上限」档位的第二列，单位**每小时**。休息面板 lblSatisfy 显示 " +N/h"
//   （DormRestPopupPanel.lua:131）。参数 = DormMgr.getComfortPoint() = p_dorm_detail_toc.prosperity，
//   服务端 furnitureProsperity() 已在下发 ⇒ 客户端显示与服务端按本表结算天然同源。
//   语义：「繁荣的协会能使誓灵的满足度更快增长」（DormRestPopupPanel ClickTip 原文）
const SATISFY_RATE = [[39, 2], [79, 3], [119, 4], [159, 5], [199, 6], [Number.MAX_SAFE_INTEGER, 7]];
function satisfyRateOf(prosperity) {
  const p = Math.max(0, Number(prosperity) || 0);
  for (const tier of SATISFY_RATE) {
    const rate = Number(tier[1]) || 2;
    if (p <= Number(tier[0])) return rate;
  }
  return 2;
}

// —— 本地服设计值（客户端零配置，同战斗涨羁绊先例集中在此便于调参）——
// 誓灵收集（CfgDorm.helpText.collects 原文：「在协会中休息的誓灵偶尔还会带来一些小惊喜～
// 繁荣度越高，誓灵会更频繁地进行收集，还会渐渐出现更稀有的道具」）：
const COLLECT_INTERVAL_H = 4;      // 每 4h 一个收集窗口（elapsed 制，离线同算）
const COLLECT_CHANCE_BASE = 0.5;   // 窗口基础命中率
const COLLECT_CHANCE_MAX = 0.9;    // 命中率封顶：0.5 + 繁荣度/2000（200→0.6，800→0.9）
const COLLECT_MAX_PER = 3;         // 单只身上最多堆 3 条（客户端气泡只展示第 1 条，多堆无展示意义）
const COLLECT_OFFLINE_CAP_H = 12;  // 离线结算最多折算 12h（=3 个窗口），防囤积
// 掉落池：稀有度按繁荣度门槛解锁（need）。全部 ∈ CfgItems 且有消费口（D23 教训：死道具=负体验）——
// 金币/体力走资产分路（与派遣领奖 m_building_crusade_reward_tos 同口径），礼物走 grantGoods 入礼物包。
// 「金色箱子」类开箱物暂不入池：开箱消费口/形态审计未过前不冒险。
const COLLECT_POOL = [
  { id: 30000003, min: 50, max: 150, need: 0,   w: 60 }, // 金币
  { id: 30000002, min: 5,  max: 15,  need: 80,  w: 25 }, // 体力
  { id: 28000001, min: 1,  max: 1,   need: 150, w: 10 }, // 熊猫礼物盒（紫）
  { id: 28000000, min: 1,  max: 1,   need: 199, w: 5 },  // 雪兔礼物盒（金）
];
function collectChanceOf(prosperity) {
  return Math.min(COLLECT_CHANCE_MAX, COLLECT_CHANCE_BASE + Math.max(0, Number(prosperity) || 0) / 2000);
}
// 按权重抽一件（只看繁荣度达标条目）；rng 可注入（冒烟用固定骰子）
function rollCollect(prosperity, rng) {
  const r = rng || Math.random;
  const p = Math.max(0, Number(prosperity) || 0);
  const pool = COLLECT_POOL.filter(x => p >= Number(x.need || 0));
  const fallback = COLLECT_POOL[0];
  if (!pool.length) return { id: fallback.id, val: fallback.min };
  const total = pool.reduce((n, x) => n + (Number(x.w) || 1), 0);
  let t = r() * total;
  for (const x of pool) {
    t -= Number(x.w) || 1;
    if (t < 0) {
      const span = Math.max(0, Number(x.max) - Number(x.min));
      return { id: Number(x.id), val: Number(x.min) + (span > 0 ? Math.floor(r() * (span + 1)) : 0) };
    }
  }
  const last = pool[pool.length - 1];
  return { id: Number(last.id), val: Number(last.min) };
}

// 誓灵状态位：休息位 = ServantUtil.isDormRest = BitUtil.getIntNBit(status, 10)。
// ⚠️ getIntNBit 是 **1-indexed 自 LSB**（返回 slot3[33-n]，data32[i]=2^(32-i)）→ n=10 即值 2^9=512。
//   佐证：STATUS_WORK=3584 = 512|1024|2048 恰好是 isWork 的 10/11/12 三位。
// 主城收集图标 DormMgr.getDormRewardServants() 只数 isDormRest 的誓灵 ⇒ 不置位气泡永不亮。
const STATUS_DORM_REST = 512;

const MESSAGE_MAX_LEN = 40; // 寄语长度上限（官方码 673001 有，具体值不可考；按面板宽度取 40 字）

// 已缔结灵契（ServantFeelVO.isMarry = marryTime > 0）
function isMarried(b) {
  return Number(b && b.pledge_time) > 0;
}
// 羁绊上限（ServantFeelVO.getMaxFeel）
function maxFeelingOf(b) {
  return isMarried(b) ? FD.FEELING_MAX_MARRY : FD.FEELING_MAX;
}
function feelingOf(b) {
  return Math.max(0, Math.min(maxFeelingOf(b), Number(b && b.feeling) || 0));
}
function isFeelingFull(b) {
  return feelingOf(b) >= maxFeelingOf(b);
}

// 心情段位（CfgServant.feelingCommon）——仅日志/调试可读性
function moodOf(feeling) {
  const f = Number(feeling) || 0;
  const m = FD.MOODS.find(x => f >= x.from && f <= x.to);
  return m ? m.title : '';
}

// 每日心愿：**不落盘**，按 (servantId, 日期) 确定性散列生成。
// 这样重启/切号都稳定，也不用为每只誓灵存一条记录；日切自然换新心愿。
// 返回 {type: 1 NORMAL | 2 MISTERY, val: tagId 1..26}
function wishOf(servantId, dayKey) {
  let h = 2166136261;
  const s = String(servantId) + '|' + String(dayKey);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return {
    type: (h % 4 === 0) ? 2 : 1,                 // 1/4 概率是神秘心愿（倍率更高但只给文字暗示）
    val: ((h >>> 8) % FD.GIFT_TAGS.length) + 1,  // tag 1..26
  };
}

// 礼物是否命中心愿：CfgGift.preference[giftId] 含 wish.val，或首元素为 0（万能礼物盒）
function hitsWish(giftId, wish) {
  const tags = FD.GIFT_PREFERENCE[String(giftId)];
  if (!tags || !tags.length) return false;   // 无 preference 配置（神秘的礼物等）= 永不命中
  if (Number(tags[0]) === 0) return true;    // [0] = 万能匹配
  return !!wish && tags.includes(Number(wish.val));
}

// 一次送礼的 satisfaction 增量
function giftGain(giftId, wish) {
  const g = FD.GIFTS[String(giftId)];
  const base = g ? (SATISFACTION_BY_COLOR[g.color] || SATISFACTION_DEFAULT) : SATISFACTION_DEFAULT;
  const isWish = hitsWish(giftId, wish);
  const mul = isWish ? (WISH_MUL[Number(wish && wish.type)] || 2) : 1;
  return { gain: base * mul, isWish, base, mul };
}

// 把 satisfaction 增量落到 brief 上（就地修改 feeling / satisfaction / feeling_record）。
// 返回 {before, feeling, satisfaction, points, milestones, capped}
//   points     = 本次涨了几点羁绊（客户端 DormRestPopupItem 按 新feeling-旧feeling 播逐点动画）
//   milestones = 本次跨过的里程碑（已写进 feeling_record）
//   capped     = 触顶后被丢弃的增量
function applyGain(b, gain, nowSec) {
  const max = maxFeelingOf(b);
  const before = feelingOf(b);
  let feeling = before;
  let sat = Math.max(0, Number(b.satisfaction) || 0) + Math.max(0, Math.floor(gain));
  let capped = 0;
  while (sat >= FD.SATISFACTION_PER_POINT && feeling < max) {
    sat -= FD.SATISFACTION_PER_POINT;
    feeling += 1;
  }
  if (feeling >= max) { capped = sat; sat = 0; } // 触顶：进度条清零，多余丢弃
  b.feeling = feeling;
  b.satisfaction = sat;
  // 里程碑时间戳（只记 50/100；客户端 setFeelingTime 只在收到 key=7 时补当前值那一格）
  if (!Array.isArray(b.feeling_record)) b.feeling_record = [];
  const milestones = [];
  for (const ms of FD.RECORD_MILESTONES) {
    if (before < ms && feeling >= ms && !b.feeling_record.some(r => Number(r.id) === ms)) {
      b.feeling_record.push({ id: ms, val: nowSec });
      milestones.push(ms);
    }
  }
  return { before, feeling, satisfaction: sat, points: feeling - before, milestones, capped };
}

module.exports = {
  SATISFACTION_BY_COLOR, SATISFACTION_DEFAULT, WISH_MUL, GIFT_TIMES_PER_SLOT,
  BATTLE_CHANCE, BATTLE_GAIN, BATTLE_DAILY_CAP, ACT_FEEL_MUL_ID, ACT_FEEL_MUL,
  TOUCH_PLAY_TYPE, TOUCH_LEGACY_PLAY_TYPE, TOUCH_CV_MIN, TOUCH_CV_MAX,
  TOUCH_SATISFACTION, TOUCH_DAILY_LIMIT, TOUCH_DAILY_FEELING_CAP, TOUCH_COOLDOWN_SEC,
  PLEDGE_NEED_FEELING, RENAME_CD_DAYS, MESSAGE_MAX_LEN, ERR,
  isMarried, maxFeelingOf, feelingOf, isFeelingFull, moodOf,
  wishOf, hitsWish, giftGain, applyGain,
  SATISFY_RATE, satisfyRateOf,
  COLLECT_INTERVAL_H, COLLECT_CHANCE_BASE, COLLECT_CHANCE_MAX, COLLECT_MAX_PER, COLLECT_OFFLINE_CAP_H,
  COLLECT_POOL, collectChanceOf, rollCollect,
  STATUS_DORM_REST,
};
