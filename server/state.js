// 全部玩家/会话状态集中于此（重构自 start.js，逻辑未变）。
// 新增状态三步走：freshState() 加字段 → loadState 补默认 → saveState 补序列化。
//
// 【多账号（2026-08-28）】S 仍然是**单例**（全部 handler 都 `const { S } = require('../state')`
// 拿的是同一个对象引用），账号隔离靠"换存档文件 + 就地重置 S 的全部字段"实现：
//   useAccount(acc) → 落盘旧账号 → resetState() 清空 S → stateFile 指向 saves/<acc>.json → loadState()
// 因此 **S 绝不能被整体重新赋值**（那样 handler 手里的引用会指向旧对象），只能改它的字段。
// 单例的代价：同一时刻只能有一个账号在线，第二个连接登录会顶掉第一个（见 handlers/role.js）。
const fs = require('fs');
const path = require('path');
const { log } = require('./log');
const ST_ENEMY = require('./data/servant_types'); // 敌方伪誓灵自愈（loadState 尾部，按类型幂等）

// 默认存档文件 = 旧的单一存档。离线冒烟测试都靠"拦 fs.writeFileSync 到这个路径"来防写盘，
// 所以**默认值必须保持不变**；只有 useAccount() 会把它切到 saves/<账号>.json。
const STATE_FILE = path.join(__dirname, 'player_state.json');
// 测试期存档覆盖：设置 PS_STATE_FILE 环境变量后，loadState/saveState 一律指向该路径，
// 从根上杜绝离线脚本污染真实存档（E2 第五次复发的固化防线，2026-10-17）。
// 优先级最高，useAccount 也不得覆盖它。
const ENV_STATE_FILE = process.env.PS_STATE_FILE ? path.resolve(process.env.PS_STATE_FILE) : null;
let stateFile = ENV_STATE_FILE || STATE_FILE;
let currentAccount = null; // {name, save, ...}（accounts.js 的账号记录），null=未走账号流程
let lastPersistedPayload = null;
let lastPersistedFile = null;
let pendingSaveTimer = null;
let pendingSave = false;
// 写盘事务：batchWrites(fn) 期间的所有 saveState 只记脏、退出时合并写一次。
// 用途：战斗结算一条链上会触发多次 saveState（结算/星云/任务/羁绊…），每次真机 fsync
// 500~950ms，把「成对协议」拉出秒级间隔 → 客户端误报「战斗结果还没收到」（2026-10-17）。
let batchDepth = 0;
let batchDirty = false;

const STARTER_TYPES = [1331003, 1432003, 1033004];
const servantBagSize = 100;
const MISSIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'missions_data.json'), 'utf8'));
// 场景主题全集（CfgMain.themes，见 data/main_themes.js 头注释）——loadState 用它做越界回落
const { THEME_IDS: THEME_ALL } = require('./data/main_themes');

const freshState = () => ({
  roleName: '指挥官',
  servants: [], helperIdList: [], formations: {}, bagSizes: {},
  servantBagSize: 100,
  nextServantId: 90000001,
  // 协会（Dorm）状态。lv = 扩建等级（CfgHouse.level 1..3：15/20/25 边长、40/110/200 繁荣度上限）。
  // 旧档没有 lv 字段 → loadState 补 1（见下方 dormState 补丁块）。
  // useTheme = 当前协会主题（CfgHouse.theme 1..5）；themes = 已解锁主题 {id:1}；
  // plans = 摆设方案 {inside:[{id,imgId,name,furnitures}], outside:[...]}；
  // 每个方案的 furnitures 是 [{fur_id,type_id,pos}]（与场景同一形状），切换方案时整份换上去。
  dormState: {
    lv: 1, slots: 0, servants: [], furnitures: [], nextFurId: 100,
    warehouse: {}, buildings: {}, troops: [],
    name: '', useTheme: 1, themes: {}, plans: { inside: [], outside: [] }, nextPlanId: 1,
    currentPlan: { inside: 0, outside: 0 }, // 室内/室外各自"使用中"的方案 id
    // 补给站（CfgDorm.supply）：shelves[id] = {goods, sup_goods, free, at, unlocked}
    // goods/sup_goods = 该货架的经验存量（普通/高级），free = 今日剩余免费次数，at = 上次结算秒
    shelves: {}, shelfDay: '',
    // 时光银行（CfgDorm.study[4]）：满级誓灵溢出经验按转化率存入，上限随繁荣度等级
    bankExp: 0,
  },
  skinState: { owned: [], l2dOwned: [] },
  helperState: { lastHelper: 0 },
  // 场景主题（个人信息页"场景主题"，handlers/role.js）：use=当前使用的主题 id（CfgMain.themes，1=默认主题）、
  // effect=主题特效开关（1/0）。解锁不落盘——全量默认解锁（ids 恒等 CfgMain 主题全集，新号同）。
  themeState: { use: 1, effect: 1 },
  // 勋章佩戴位（个人信息页"勋章"装饰，handlers/role.js）：use=[4 个槽位]，0=空位、其余=CfgRole.medal id。
  // 拥有列表不落盘——全量默认拥有（恒等 CfgRole.medal 全集 val=1，新号同），见 data/medal_data.js。
  medalState: { use: [0, 0, 0, 0] },
  // 主城快捷面板（MainAppPanel）自定布局：[{page, positions:[{id,val}]}]（null=未拖动过，
  // 走 CfgMain.mainApps 默认布局）。二百七十五：m_main_app_info_tos 必须回真实 pages，
  // 否则重连后客户端 initByConfig 热缓存重建出空页 = 面板空白。
  mainAppLayout: null,
  bagGoods: [], nextGoodsId: 1,
  // 一次性存档迁移标记 {迁移键: true}（迁移只跑一次，之后玩家的真实数据不再被覆盖）
  migrations: {},
  musicState: { scores: {}, today: 0 },
  clientInfo: {}, // 客户端信息位 {id: val}（id=1053 主线副本页"活动好感位引导已开"）
  redPointHidden: {}, // 已点掉的入口红点 {id:1}（二百二十二：登录链 m_red_point_toc 推回 val=0）
  roleAsset: { gold: 10000, gold_given: 10000, silver: 100000, scores: { 5: 1000 } },
  // 结社（Family）：familyId=0 表示无结社；members/applies 为 NPC 成员与待审批（本地服无其他玩家）
  familyState: {
    familyId: 0, name: '', lv: 1, exp: 0, intro: '', style: 1, logo: 10,
    job: 30, sign: 0, signDay: '', autoAccept: 0, autoExchange: [], notices: [],
    members: [], applies: [], appliedTo: [], banTime: 0, isNpcFamily: 0,
    shopBought: {}, shopWeekKey: '', bossUseTimes: 0, bossDay: '',
    contDay: '', contToday: 0, contYesterday: 0, myToday: 0, myYesterday: 0,
    rankYesterday: 0, rewardState: 0, halos: {},
  },
  theaterState: { played: [] },
  missionState: { counters: {}, claimed: [], loginDays: 0, lastLoginDay: '', dailyActivity: 0, activityReward: [], dailyKey: '', weeklyKey: '' },
  jumpState: { max_score: 0, daily_score: 0, top_times: 0 },
  candyState: { remain: 200, buff_times: 0, protect_times: 20, rare: [], day: '', vitRem: 0 },
  // 体力（vit=role_scores[5]）：买体力次数按天重置，studyAt 记录研究所产出上次领取时间
  vitState: { buyTime: 0, buyDay: '', studyAt: {} },
  // 阵型（Lineup）：touched=已点掉 new 角标的阵型（1 突击默认开启，不亮 new）；forced=GM 强制解锁；synced=已同步给客户端的解锁集
  lineupState: { touched: [1], forced: [], synced: [] },
  // 天空方舟（Ark）：events=当前地图事件（oid=serial*1000+显示id）、scienceDone/queue=科研、
  // cards=指令卡收藏、teams=探索队（属性→誓灵id）、war=进行中指令战、fuelAt=燃料结算时点
  arkState: null,
  // 祭坛（Altar，功能26 通关3-4）：unlockedCamps=已解锁阵营、unlockedSlots=额外解锁供奉位
  //（配置 cost[0,0] 的免费位不记）、enshrined=供奉 {typeId:{camp,slot}}、fameSynced=已推送名气快照
  altarState: null,
  // 通用商店（Shop）：bought={goodsId:已购次数}、seedDay/rotCount=限时特惠轮换种子（每日 04:00 + 手动刷新）
  shopState: null,
  // 图鉴（Handbook）：actives={图鉴typeId(狂化=100000000+本体):获得时间}、likes/skinLikes=点赞、
  // mvGot=已领的羁绊剧情奖励、unseen/skinUnseen=新解锁未查看（红点/is_new）
  handbookState: null,
  // 银匙之门（Dream，功能16 通关5-4）：now/max=当前与历史最深关、isFight=挑战中、failTimes=本次失败数、
  // dailyLeft/buyTimes=今日剩余挑战次数与已购钥之匙次数（day 跨天重置）、embattle={pos:誓灵id}、cleared=已首通关号
  dreamState: null,
  // 曜日副本（每日材料本，功能4 通关2-3）：day=次数所属本地日期、times={章号:今日已用}、
  // cleared=已通关关卡（三星/pass_times 判定）、forceOpen=GM 强制三章全开（绕过星期轮换自测）
  dailyCopyState: null,
  // 主线 EX 挑战关（handlers/map_fight.js）：day/used=今日已通关 EX 关数（每日 3 次，跨天重置；
  // 客户端 getExCopyRemainTimes = 3 - getDailyTimes(20004)，id 走 m_activity_daily_toc/m_role_daily_update_toc）
  exState: null,
  // 主线首通奖励 + 主线双倍（handlers/story_reward.js）：claimed=已领首通的 barrierId、
  // doubleTimes=持有双倍次数（上限 10，不跨天清）、buyDay/buyUsed=今日已购买次数（跨天重置）、
  // switchOn=主线页双倍开关
  storyState: null,
  // 羁绊（handlers/feeling.js）：day/giftUsed=今日已送礼次数、battleGain={誓灵id:今日战斗已涨 satisfaction}、
  // dormChecked=休息室"羁绊已满"红点已确认名单（心愿不落盘，按 (誓灵id,日期) 确定性散列生成）
  feelingState: null,
  // 召唤（handlers/summon.js）：pulls={池id:累计抽数}（info.list[].time 与新手池关闭都用它）、
  // dayPulls/freeUsed 按天重置、pity={池id:保底计数}、affinityGot=已灵契兑换的 servantTypeID、
  // closed={池id:关闭时刻}
  summonState: null,
  // 信仰（handlers/faith.js）：plans=[{id,name,detail:[{id:pos,val:gid}]}] 方案（最多 3 条）。
  // 装备态本身存在 S.servants 上（faiths={pos:gid} 本体套装、faithTeams={teamId:{pos:gid}} 分队套装），
  // 与 relic_gid/cores 同性质；信仰实例的 level/exp/sideColor 存在 S.bagGoods 对应物品上。
  faithState: { plans: [] },
  // 作战策略（handlers/skill_choice.js，SkillChoice 模块）：modeId=4 自动（modeValue 0 最优/1 单体至上/
  // 2 群体优先，CfgSkillChoice.modeArr 三档）/ 6 自行（按誓灵 ai_skills 循环出技）。
  // tactics={槽id1..6:{id,name,servants:[{id:誓灵id,list:[技能id]}]}}（6 槽固定，SkillChoiceMgr.saveMaxNum）、
  // sort=槽显示顺序、applied={teamId:槽id}（应用记录，战斗消费走誓灵 ai_skills，此字段备查）。
  // 默认 {4,0} 与客户端模块初始值一致（SkillChoiceMgr._currMode=MODE_AUTO/_currValue=MODE_AUTO_STRATEGY）。
  aiState: { modeId: 4, modeValue: 0, tactics: {}, sort: [1, 2, 3, 4, 5, 6], applied: {} },
  // 日常/周常重置标记…（下行保持原样）
  // 唤灵殿堂（handlers/dare.js）：weekKey=每周奖励所属周（周一重置）、defeated=已战胜 bossID、
  // claimedFirst=已领首通、claimedTiers={章:已领档}、gotItems=本周已领项、lastTeam=dare 编队槽、
  // spirit={誓灵id:{val,at}}（元气：上限100、每3分钟回1）
  dareState: null,
  // 成就（handlers/achievement.js）：claimed=已领 id、claimTime、counters=增量计数器
  // （kills/killsNature/barrierClears/slimeClears/dareDamage/summons/...）、snapshot=上次下发态
  achvState: null,
  // 无尽冒险（handlers/tower.js）：weekKey=每周一重置、claimed={层:1}本周首胜、weekMax/historyMax、
  // recoverUsed=恢复存量、barrier=当前进度、milestones=已领里程碑、
  // team={slots{1-12:誓灵id}, savedHp{誓灵id:{hp,skillsState}}, fromBarrier}（HP 跨层冻结）
  towerState: null,
  towerRecords: null, // 塔战录像库（回放/战果；LRU 10 场）
  // 新手引导（handlers/guide.js + data/guide_data.js）：done=已上报完成的引导组、last=last_guide_id。
  // **null = 老档/已全部完成**（登录下发空未完成列表 + last=53）；新建账号在 useAccount 里
  // 显式置 {done:[], last:0} 让客户端跑完整新手链（视频/剧情/首战教学/自设名/选灵/二战/……）
  guideState: null,
  // 元素精灵「已激活」（FUNC_ID_ACT_ELEMENT=22）。客户端点元素槽位时发 guide_do(122,2,true)，
  // 服务端置 1 并补推 22。老档 guideState 可能为 null（引导全完成），不能只靠 done 列表记。
  elementActivated: 0,
  // 御灵士（handlers/grow.js）：stars={节点id:lv}、exp/weekExp/weekKey=星云点与周上限、
  // expFloat=战斗转化小数累积、costume=null(未创建)|{sex,motion[3],wear{partType:typeId},dyes{typeId:{dyeID:色}}},
  // seen={typeId:1}=衣柜已查看（p_suit2.view / isNew 红点）
  growState: null,
  // 言灵录（ServantMoment，handlers/moment.js）：unlocked={m_id:解锁时刻}、read={m_id:1}、
  // reply={m_id:{choice,reply}}（选项回复只能选一次）、custom={m_id:{content}}（自定义回复只能发一次）、
  // momentLikes/commentLikes=玩家点的赞、dispatchGroups/wonWith/clearedWith=触发条件用的历史、
  // firstOwn={誓灵type:获得时刻}（ownDays 条件）、backfilled=存量获得时间是否已回填
  momentState: null,
  actExtraState: null,
  // 每日签到（活动 1001，handlers/activity.js）：listId=周期号 YYYYMM（换月重开 7 天循环）、
  // days=本周期已签天数(0..7)、lastDay=最近签到日(YYYY-M-D，同日防重)
  signState: { listId: 0, days: 0, lastDay: '' },
  collabState: null,
  levelRewardState: { claimed: [] },
  actFavorState: { favor: 0, claimed: [], is_helper: 0, counters: {} },
  copyRewardState: { claimed: [] },
  mapProgress: { maps: {} },
  mapState: null, fightState: null, nextFightId: 1,
  dreamFight: null, // 幻梦战会话态（不落盘，与 fightState 同性质）
  // 信件（handlers/letter.js）：createTime=注册时刻（useAccount created 时落）、
  // letters={id,code,state,lock,claimed,time,sender,title,text,fixed,goods}、
  // fixed=2 的公益信**存档不落正文**（发送瞬间从 letter_post.bin 解码，防明文扫描）
  letterState: null,
  // 称号（handlers/title.js）：owned={titleID: 1拥有未激活|2已激活}、usePre/useSuf=佩戴位(0=空)
  titleState: null,
  // 贴纸涂鸦板（handlers/artwork.js，二百八十）：openPage=已解锁页数(1..3)、
  // pages={页号:[{id,mat,transform,tier}]}（id 服务端分配，transform 客户端位包透传）、
  // mats={素材id:累计获得}。素材剩余**不落盘**——由 mats − 各页已放置数推导（永不漂移）。
  artworkState: null,
  // 头像/头像框（handlers/avatar.js，二百九十七）：borders={框id: 1新获得|0已查看}（客户端
  // RoleHeadVO val 语义，只存已拥有的）、heads={特殊头像id:1}、use={border,head,face,useType}
  // =登录 attr (avatar_border/head/servant_face/use_avatar) 唯一来源。默认自带 41000000。
  headState: null,
  // 名片展示编队（个人主页第二页 RoleAssistantView，二百八十一）：servants=**固定 6 槽、
  // 0=空位**（客户端 getAddOutCardIndex/getOutCardNum 按 0 记空位）、name=展示编队名。
  // 展示纯装饰，无战斗效果；誓灵被分解/删除时 scrubServantRefs 清槽。
  showTeamState: { servants: [0, 0, 0, 0, 0, 0], name: '' },
  // 个人简介（m_role_profile_intro_tos，二百八十一顺手闭环）：登录链 m_role_profile_info_toc
  // 的 intro 字段此前写死 ''——简介永远空、修改协议未实现
  profileIntro: '',
});

const S = freshState();

// 存量塔战录像自愈（2026-11-05，「自动战斗回放卡死」收尾）：
// 修复前自动战斗 tick 绕过 pushRound，把 `resolveRound` 的**内部 id**（我方 9000007x /
// 敌方 7500000x）直接写进 `f.record.rounds`，而同一场的 `units` 是 `unitToc` 产出的
// wire bid 形态（100.. / 2100..）⇒ 回放时客户端 `SceneUnitManager` 查不到单位、
// `FightLoop.CheckAct` 里 `GetUnit(...):Play` 无 nil 守卫 ⇒ 每帧报错、回合不推进。
// 修法：loadState 时校验每场录像的"可解析性"，坏场次整场丢弃（连同 floorRecords 指向它的键）。
//
// 判据（与客户端回放时序同构，宁严勿宽）：
//   · 可见集合 = units ∪ rounds[0].enter_list（客户端 index=2 时把这两者一起喂进场景）；
//   · 之后每回合推进时先并入该回合的 enter_list（替补登场），再校验 fight_list 的
//     atk_id / effect.target 都在可见集合内；
//   · rounds[0].enter_list 在存盘时已按"去掉 units 里已有的 id"过滤过（finishRecord），
//     这里不依赖该细节，直接用并集。
// 只在**确实出过坏录像**时才写盘（由调用方决定），且不产生额外 saveState。
function scrubBadTowerRecords() {
  const all = S.towerRecords;
  if (!all || typeof all !== 'object') return 0;
  const bad = [];
  for (const [key, rec] of Object.entries(all)) {
    if (!rec || !Array.isArray(rec.units) || !Array.isArray(rec.rounds)) { bad.push(key); continue; }
    const visible = new Set(rec.units.map(u => Number(u && u.id)));
    let broken = false;
    for (let i = 0; i < rec.rounds.length && !broken; i++) {
      const rd = rec.rounds[i] || {};
      for (const u of rd.enter_list || []) visible.add(Number(u && u.id));
      for (const a of rd.fight_list || []) {
        if (!visible.has(Number(a && a.atk_id))) { broken = true; break; }
        for (const e of (a && a.effect_list) || []) {
          // 目标 0 = 无目标/自身类 effect（部分演出型条目），不算悬空
          const tar = Number(e && e.target);
          if (tar && !visible.has(tar)) { broken = true; break; }
        }
        if (broken) break;
      }
    }
    if (broken) bad.push(key);
  }
  if (!bad.length) return 0;
  for (const key of bad) {
    const recId = Number(all[key] && all[key].id) || Number(key);
    delete all[key];
    const fr = S.towerState && S.towerState.floorRecords;
    if (fr) {
      for (const [fl, rid] of Object.entries(fr)) {
        if (Number(rid) === recId) delete fr[fl];   // 该层的战果/回放入口一并失效（回落"本关还没挑战"）
      }
    }
  }
  return bad.length;
}

// 就地清空并重填 S（换账号时用）。**不能 S = freshState()**：handler 持有的是引用。
function resetState() {
  for (const k of Object.keys(S)) delete S[k];
  Object.assign(S, freshState());
}

function loadState() {
  let dirtySave = false;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s.roleName) S.roleName = s.roleName; // 多账号前 roleName 从不落盘（改名重启即丢），一并补上
    S.servants = s.servants || [];
    S.helperIdList = s.helperIdList || [];
    S.formations = s.formations || {};
    S.bagSizes = s.bagSizes || {};
    S.servantBagSize = (typeof s.servantBagSize === 'number' && s.servantBagSize > 0) ? s.servantBagSize : 100;
    S.mapProgress = s.mapProgress || {};
    S.nextServantId = s.nextServantId || 90000001;
    // 重复实例 id 去重（自愈）：客户端 ServantMgr.addServant（bc asm 实证）对已存在 id
    // **不建 VO 但类型计数表仍 +1** —— brief 重复下发同一 id 会让客户端出现
    // 「计数>0 但实例列表为空」错位，玩家破除该实例后每次
    // m_servant_type_fame_update_toc → ServantAltarDetailVO.updateRankList 必崩
    // （真机 2026-10-14 破除誓约报错）。保留第一份（先入档者；后份视为脏数据丢弃），
    // nextServantId 同步抬到 maxId+1 防止 id 分配器回退再次撞号。
    if (S.servants.length > 1) {
      const seen = new Set();
      const deduped = [];
      const dupIds = [];
      for (const b of S.servants) {
        const id = Number(b && b.id);
        if (!id || seen.has(id)) { dupIds.push(id); continue; }
        seen.add(id);
        deduped.push(b);
      }
      if (dupIds.length) {
        log(`[state] ⚠ 存档含 ${dupIds.length} 个重复实例 id（${[...new Set(dupIds)].join(',')}），已去重保留第一份`);
        S.servants = deduped;
        const maxId = deduped.reduce((m, b) => Math.max(m, Number(b.id)), 0);
        if (S.nextServantId <= maxId) {
          log(`[state] nextServantId ${S.nextServantId} ≤ maxId ${maxId}，抬到 ${maxId + 1}（防 id 分配器回退再次撞号）`);
          S.nextServantId = maxId + 1;
        }
        dirtySave = true;
      }
    }
    S.dormState = s.dormState || { slots: 0 };
    // 扩建等级（CfgHouse.level 只有 1..3）。旧档无此字段 → 1；越界（手改/未来配置缩水）也回落。
    // 客户端 HouseScene 用 getSize(dorm_level) 定地图边长、DormPanel 用 getLevelMaxPoint(dorm_level)
    // 定繁荣度上限，传 0/4 会 level[nil] 崩（见工作日志「协会点不增加」条的同类教训）。
    S.dormState.lv = Math.min(3, Math.max(1, Number(s.dormState && s.dormState.lv) || 1));
    if (!S.dormState.servants) S.dormState.servants = []; // [{servant_id, slot}] 入住誓灵
    // 休息位记录字段默认值（二百七十四）：since/collectAt 缺省 = 载入时刻（不给旧档追溯涨好感）
    for (const rec of S.dormState.servants) {
      if (!(Number(rec.since) > 0)) rec.since = Math.floor(Date.now() / 1000);
      if (!(Number(rec.collectAt) > 0)) rec.collectAt = rec.since;
      if (!Array.isArray(rec.reward)) rec.reward = [];
    }
    if (!S.dormState.furnitures) S.dormState.furnitures = []; // 摆设 [{fur_id, type_id, pos}]
    if (!S.dormState.nextFurId) S.dormState.nextFurId = 100;
    if (!S.dormState.warehouse) S.dormState.warehouse = {}; // 家具仓库 {type_id: 数量}
    if (!S.dormState.buildings) S.dormState.buildings = {}; // 建筑等级 bdID→lv
    if (!S.dormState.troops) S.dormState.troops = []; // 派遣队 p_crusade_troop 形状
    // 主题 / 摆设方案（二百一十五）：旧档无这些字段 → 补默认；结构损坏也要能自愈
    if (typeof S.dormState.name !== 'string') S.dormState.name = '';
    S.dormState.useTheme = Math.min(5, Math.max(1, Number(s.dormState && s.dormState.useTheme) || 1));
    if (!S.dormState.themes || typeof S.dormState.themes !== 'object') S.dormState.themes = {};
    if (!S.dormState.plans || typeof S.dormState.plans !== 'object') S.dormState.plans = {};
    for (const side of ['inside', 'outside']) {
      if (!Array.isArray(S.dormState.plans[side])) S.dormState.plans[side] = [];
    }
    if (!Number.isInteger(Number(S.dormState.nextPlanId)) || Number(S.dormState.nextPlanId) < 1) {
      // 旧档/手改过的 nextPlanId：从现有方案里取最大 id + 1，避免撞号
      const maxId = [...S.dormState.plans.inside, ...S.dormState.plans.outside]
        .reduce((m, p) => Math.max(m, Number(p && p.id) || 0), 0);
      S.dormState.nextPlanId = maxId + 1;
    }
    S.dormState.nextPlanId = Number(S.dormState.nextPlanId);
    // 当前使用中的方案 id：必须是该 side 下真实存在的方案，否则回落 0
    if (!S.dormState.currentPlan || typeof S.dormState.currentPlan !== 'object') {
      S.dormState.currentPlan = { inside: 0, outside: 0 };
    }
    for (const side of ['inside', 'outside']) {
      const id = Number(S.dormState.currentPlan[side]) || 0;
      const exists = id && (S.dormState.plans[side] || []).some(p => Number(p.id) === id);
      if (!exists) S.dormState.currentPlan[side] = 0;
    }
    // 补给站 / 时光银行（二百一十六）：结构损坏要能自愈（旧档无字段 → 空对象 + 0）。
    // shelves 的条目按需惰性创建（shelfState() 里补），这里只保证容器类型正确。
    if (!S.dormState.shelves || typeof S.dormState.shelves !== 'object') S.dormState.shelves = {};
    if (typeof S.dormState.shelfDay !== 'string') S.dormState.shelfDay = '';
    S.dormState.bankExp = Math.max(0, Math.floor(Number(S.dormState.bankExp) || 0));
    S.skinState = s.skinState || { owned: [], l2dOwned: [] };
    if (!S.skinState.owned) S.skinState.owned = [];
    if (!S.skinState.l2dOwned) S.skinState.l2dOwned = [];
    // 信件 / 称号（调研-固定邮件两封）：老档无字段 → null（letter.stOf / title.ownedOf 惰性补容器）；
    // createTime=0 由 letter.onLogin 首登回填（视为已满 72h → 老档收公益信、不收欢迎信）
    S.letterState = s.letterState || null;
    S.titleState = s.titleState || null;
    S.migrations = s.migrations || {};
    if (!S.migrations.l2d_owned_init) {
      let skinCfg = {};
      try {
        skinCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'skin_config.json'), 'utf8')) || {};
      } catch (e) {}
      const l2dSet = new Set((skinCfg.live2dSkins || []).map(Number));
      for (const skinId of S.skinState.owned) {
        if (l2dSet.has(Number(skinId)) && !S.skinState.l2dOwned.includes(Number(skinId))) {
          S.skinState.l2dOwned.push(Number(skinId));
        }
      }
      S.migrations.l2d_owned_init = true;
      dirtySave = true;
    }
    S.helperState = s.helperState || { lastHelper: 0 };
    S.themeState = Object.assign({ use: 1, effect: 1 }, s.themeState || {});
    if (!THEME_ALL.includes(Number(S.themeState.use))) S.themeState.use = 1; // 主题 id 越界（配置外）回落默认主题
    // 主城快捷面板自定布局：只收数组形态，其余（旧档无此字段/手改坏档）一律 null 走默认布局
    S.mainAppLayout = Array.isArray(s.mainAppLayout) ? s.mainAppLayout : null;
    // 勋章佩戴位：裁/补到 4 槽，槽内非法 id（非 CfgRole.medal）清空
    S.medalState = s.medalState || {};
    const { MEDAL_IDS: MEDAL_ALL, MEDAL_SLOTS } = require('./data/medal_data');
    S.medalState.use = Array.from({ length: MEDAL_SLOTS }, (_, i) => {
      const v = Number((s.medalState && s.medalState.use && s.medalState.use[i]) || 0);
      return MEDAL_ALL.includes(v) ? v : 0;
    });
    const rawGoods = s.bagGoods || [];
    let dirtyGoods = false;
    const validGoods = rawGoods.filter(g => {
      const ok = g && Number(g.type_id) > 0;
      if (!ok) dirtyGoods = true;
      return ok;
    });
    S.bagGoods = validGoods;
    if (dirtyGoods) {
      log(`[state] 自动修复存档：移除了 ${rawGoods.length - validGoods.length} 个无效道具（type_id 为空或 <=0）`);
      dirtySave = true;
    }
    // 礼物分页（2026-10-21 修正）：只有 CfgGift.preference 有键的道具能进 bag_type=6。
    //   旧迁移 giftBagType6 按「28 前缀」一刀切，把 28000024/28000025（神秘的礼物 Lv1/Lv2，
    //   开箱类，CfgItems.form=3）也塞进了隐藏礼物包 → 客户端 DormGiftView.sortGift 调
    //   DormConfig.getItemPreference() 得 nil → table.isExist(nil) → pairs(nil) 抛异常，
    //   协会/宿舍「休息→送礼」面板一打开就崩（苏芸曦 2026-10-19 真机 5 次）。
    //   本迁移双向纠正：真礼物 → 6，其余 28* → 1（材料页）。幂等靠独立标记。
    if (!S.migrations.giftBagType6Real) {
      // 白名单直接用 feeling_data.GIFT_PREFERENCE（= 客户端 CfgGift.preference，24 条，零依赖），
      // 不 require lib.js —— state ↔ lib 有循环引用，这里必须保持单向。
      const pref = require('./data/feeling_data').GIFT_PREFERENCE || {};
      const real = new Set(Object.keys(pref).map(Number));
      let toGift = 0, toMat = 0;
      for (const g of S.bagGoods) {
        if (!String(g.type_id || '').startsWith('28')) continue;
        const want = real.has(Number(g.type_id)) ? 6 : 1;
        if (Number(g.bag_type) !== want) {
          g.bag_type = want;
          if (want === 6) toGift++; else toMat++;
        }
      }
      S.migrations.giftBagType6Real = true;
      if (toGift || toMat) {
        log(`[state] 迁移礼物背包分页（白名单口径）：${toGift} 项 → bag_type=6，${toMat} 项 28xxxxxx 开箱类 → bag_type=1`);
        dirtySave = true;
      }
    }
    // 贴纸涂鸦板（二百八十）：老档无字段 → 补默认；结构损坏自愈；页号/素材归属/instance id 校验；
    // **包内 261xxx 存量原地转换**——关卡掉落 others 池（26100028-30 等）/ 赫拉 7003 / 活动积分榜
    // 早年直接发放进包的贴纸素材是点不开的死道具（form=2+link=0），转换进涂鸦库存。
    // 不设 migrations 门（二百七十九口径）：修复后 grantGoods 永不再发 261 入包，本块每次空转、天然幂等。
    // ⚠️ 键语义（二百八十真机事故补丁，2026-10-31 晚）：涂鸦板协议 id/material_id 是
    // **typeID（1~118）**、261xxxxx 只是道具形态（客户端 getArtwork 直查 materials 数组下标，
    // 发 261xxx 会刷「涂鸦前端配置不存在」）——mats 键 / placement.mat 统一存 typeID；
    // 第一版误存 261xxx 键在此一并迁移（幂等：1~118 与 261 前缀不相交）。
    {
      const ART = require('./data/artwork_data');
      const st = (s.artworkState && typeof s.artworkState === 'object') ? s.artworkState : {};
      st.openPage = Math.min(ART.MAX_PAGE_NUM, Math.max(1, Math.floor(Number(st.openPage) || 1)));
      if (!st.pages || typeof st.pages !== 'object' || Array.isArray(st.pages)) st.pages = {};
      if (!st.mats || typeof st.mats !== 'object' || Array.isArray(st.mats)) st.mats = {};
      let maxPlaced = 0, dropPlaced = 0, rekey = 0;
      const seenIds = new Set();
      const normMat = v => {
        const t = ART.typeIdOf(v);
        if (t && Number(v) !== t) rekey++;
        return t;
      };
      for (const k of Object.keys(st.pages)) {
        const p = Number(k);
        if (!(p >= 1 && p <= ART.MAX_PAGE_NUM)) { delete st.pages[k]; dropPlaced++; continue; }
        const arr = Array.isArray(st.pages[k]) ? st.pages[k] : [];
        const cleaned = arr.filter(pl => {
          const mat = pl ? normMat(pl.mat) : 0;
          const ok = !!mat && Number(pl.id) > 0 && !seenIds.has(Number(pl.id));
          if (ok) { pl.mat = mat; seenIds.add(Number(pl.id)); } else dropPlaced++;
          return ok;
        }).map(pl => ({
          id: Math.floor(Number(pl.id)), mat: Math.floor(Number(pl.mat)),
          transform: Math.floor(Number(pl.transform) || 0), tier: Math.floor(Number(pl.tier) || 0),
        }));
        st.pages[p] = cleaned;
        for (const pl of cleaned) maxPlaced = Math.max(maxPlaced, pl.id);
      }
      if (!Number.isInteger(st.nextId) || st.nextId < 1 || st.nextId <= maxPlaced) st.nextId = maxPlaced + 1;
      const normMats = {};
      for (const k of Object.keys(st.mats)) {
        const t = normMat(k);
        if (t) normMats[t] = (normMats[t] || 0) + Math.max(0, Math.floor(Number(st.mats[k]) || 0));
      }
      S.artworkState = st;
      st.mats = normMats;
      let convN = 0;
      S.bagGoods = S.bagGoods.filter(g => {
        const t = ART.typeIdOf(g.type_id);
        if (t) {
          const n = Math.max(1, Math.floor(Number(g.cur_num) || 1));
          st.mats[t] = (Math.floor(Number(st.mats[t]) || 0)) + n;
          convN += n;
          return false;
        }
        return true;
      });
      if (convN || dropPlaced || rekey) {
        log(`[state] 存量自愈：背包 ${convN} 个贴纸素材（261xxx form=2 死道具）→ 涂鸦库存` +
          (rekey ? `；键迁移 261xxx→typeID ${rekey} 处` : '') +
          (dropPlaced ? `；剔除非法摆放 ${dropPlaced} 条` : ''));
        dirtySave = true;
      }
    }
    // 头像/头像框（二百九十七）：老档无字段 → 补默认；非法框 id 清除；use 佩戴态自愈；
    // **包内 41000xxx 存量原地转换**——dare 首通/成就/联动/关卡掉落早年直接发放进包的
    // 头像框道具是 form=2 死道具（客户端 m_goods_update_toc isToBag=false 整条丢弃），
    // 转成解锁态（已查看，不亮"新"角标——拿到已久）。不设 migrations 门（二百八十口径）：
    // 修复后 grantGoods 永不再发 41x 入包，本块每次空转、天然幂等。
    {
      const HD = require('./data/head_data');
      const st = (s.headState && typeof s.headState === 'object') ? s.headState : {};
      st.borders = (st.borders && typeof st.borders === 'object' && !Array.isArray(st.borders)) ? st.borders : {};
      st.heads = (st.heads && typeof st.heads === 'object' && !Array.isArray(st.heads)) ? st.heads : {};
      st.use = (st.use && typeof st.use === 'object' && !Array.isArray(st.use)) ? st.use : {};
      if (st.borders[HD.DEFAULT_FRAME] === undefined) st.borders[HD.DEFAULT_FRAME] = 0;
      for (const id of Object.keys(st.borders)) if (!HD.isFrameItem(id)) delete st.borders[id];
      for (const id of HD.HEAD_IDS) if (st.heads[id] === undefined) st.heads[id] = 1; // 特殊头像默认全解锁
      let convN = 0;
      S.bagGoods = S.bagGoods.filter(g => {
        const id = Number(g && g.type_id);
        if (HD.isFrameItem(id)) {
          if (st.borders[id] === undefined) { st.borders[id] = 0; convN++; }
          return false;
        }
        return true;
      });
      const ub = Math.floor(Number(st.use.border) || 0);
      if (ub !== 0 && st.borders[ub] === undefined) st.use.border = 0; // 佩戴态自愈：框不存在归零
      const uh = Math.floor(Number(st.use.head) || 0);
      if (uh !== 0 && !st.heads[uh]) st.use.head = 0;
      S.headState = st;
      if (convN) {
        log(`[state] 存量自愈：背包 ${convN} 个头像框道具（41xxxxxx form=2 死道具）→ 解锁态（已查看）`);
        dirtySave = true;
      }
    }
    // 名片展示编队（二百八十一）：固定 6 槽、0=空位；不存在的誓灵 id 清槽（幂等）。
    // 客户端 getAddOutCardIndex 找 id==0 的槽、getOutCardNum 数 id~=0 ⇒ 形状必须恒 6 长度。
    {
      const raw = (s.showTeamState && typeof s.showTeamState === 'object') ? s.showTeamState : {};
      const arr = Array.isArray(raw.servants) ? raw.servants : [];
      const owned = new Set((S.servants || []).map(b => Number(b && b.id)).filter(Boolean));
      const dropped = [];
      S.showTeamState = {
        servants: Array.from({ length: 6 }, (_, i) => {
          const id = Math.floor(Number(arr[i]) || 0);
          if (id > 0 && !owned.has(id)) { dropped.push(id); return 0; }
          return id > 0 ? id : 0;
        }),
        name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : '',
      };
      if (dropped.length) {
        log(`[state] 存量自愈：名片展示编队 ${dropped.length} 个不存在的誓灵 id 清槽（${dropped.join(',')}）`);
        dirtySave = true;
      }
    }
    // 个人简介（二百八十一）：非字符串归空
    S.profileIntro = (typeof s.profileIntro === 'string') ? s.profileIntro.slice(0, 100) : '';
    S.nextGoodsId = s.nextGoodsId || 1;
    S.musicState = s.musicState || { scores: {}, today: 0 };
    S.clientInfo = s.clientInfo || {}; // 客户端信息位 {id: val}（id=1053 主线副本页"活动好感位引导已开"，见 handlers/role.js client_info）
    S.redPointHidden = s.redPointHidden || {}; // 已点掉的入口红点（handlers/role.js m_red_point_hide_tos）
    S.roleAsset = s.roleAsset || { gold: 10000, gold_given: 10000, silver: 100000, scores: {} };
    if (!S.roleAsset.scores) S.roleAsset.scores = {}; // 角色积分 {score_id: 值}，8=结社积分（本周贡献）
    if (S.roleAsset.level == null) S.roleAsset.level = 1; // 指挥官等级（2026-08-24 起战斗结算累积经验）
    if (S.roleAsset.exp == null) S.roleAsset.exp = 0;     // 本级内经验（曲线见 data/role_level_data.js）
    if (S.roleAsset.scores[5] == null) S.roleAsset.scores[5] = 1000; // 旧存档迁移：体力初始值（新版顶栏依赖 role_scores[5]）
    // 结社（旧存档无此字段 → 补默认；数组字段必须存在，客户端对 nil 数组直接崩）
    const fsDef = {
      familyId: 0, name: '', lv: 1, exp: 0, intro: '', style: 1, logo: 10,
      job: 30, sign: 0, signDay: '', autoAccept: 0, autoExchange: [], notices: [],
      members: [], applies: [], appliedTo: [], banTime: 0, isNpcFamily: 0,
      shopBought: {}, shopWeekKey: '', bossUseTimes: 0, bossDay: '',
      // 贡献（新版客户端主面板进度条 + 昨日领奖）与光环
      contDay: '', contToday: 0, contYesterday: 0, myToday: 0, myYesterday: 0,
      rankYesterday: 0, rewardState: 0, halos: {},
    };
    S.familyState = Object.assign({}, fsDef, s.familyState || {});
    for (const k of ['autoExchange', 'notices', 'members', 'applies', 'appliedTo']) {
      if (!Array.isArray(S.familyState[k])) S.familyState[k] = [];
    }
    if (!S.familyState.shopBought) S.familyState.shopBought = {};
    if (!S.familyState.halos) S.familyState.halos = {};
    // 职位常量迁移：旧实现按 0/1/2 存（老版客户端），真机跑的新版是 0/10/20/30
    {
      const MAP = { 0: 0, 1: 10, 2: 30 };
      const fix = j => (MAP[j] != null ? MAP[j] : j);
      if (S.familyState.job <= 2) S.familyState.job = fix(S.familyState.job);
      S.familyState.members.forEach(m => { if (m.job <= 2) m.job = fix(m.job); });
    }
    S.theaterState = s.theaterState || { played: [] };
    // 日常/周常重置标记（dailyKey=本地日期，weeklyKey=本周一日期；空=下次检查即重置）
    // dailyActivity=当日活跃度，activityReward=已领活跃度宝箱下标（1-based，对应 CfgMission.activity）
    const msDef = { counters: {}, claimed: [], loginDays: 0, lastLoginDay: '', dailyActivity: 0, activityReward: [], dailyKey: '', weeklyKey: '' };
    S.missionState = Object.assign({}, msDef, s.missionState || {});
    S.missionState.counters = S.missionState.counters || {};
    S.missionState.claimed = S.missionState.claimed || [];
    S.missionState.activityReward = S.missionState.activityReward || [];
    S.vitState = Object.assign({ buyTime: 0, buyDay: '', studyAt: {} }, s.vitState || {});
    if (!S.vitState.studyAt) S.vitState.studyAt = {};
    // 阵型（旧存档无此字段 → 补默认；解锁集本身按关卡进度动态推导，无需迁移）
    S.lineupState = Object.assign({ touched: [1], forced: [], synced: [] }, s.lineupState || {});
    if (!S.lineupState.touched.includes(1)) S.lineupState.touched.push(1); // 突击默认开启不亮 new
    for (const k of ['touched', 'forced', 'synced']) {
      if (!Array.isArray(S.lineupState[k])) S.lineupState[k] = [];
    }
    // 天空方舟：整块懒初始化在 handlers/ark.js st()（首次访问补三货币初始值），这里只做形状修复
    if (s.arkState) {
      S.arkState = s.arkState;
      if (!Array.isArray(S.arkState.events)) S.arkState.events = [];
      if (!Array.isArray(S.arkState.scienceDone)) S.arkState.scienceDone = [10000];
      if (!Array.isArray(S.arkState.queue)) S.arkState.queue = [];
      if (!S.arkState.cards) S.arkState.cards = {};
      if (!S.arkState.teams) S.arkState.teams = {};
      if (!S.arkState.autoOpt) S.arkState.autoOpt = { powerFirst: 0, isAuto: 0, natures: [] };
      if (!S.arkState.fuelAt) S.arkState.fuelAt = Math.floor(Date.now() / 1000);
    }
    // 祭坛：整块懒初始化在 handlers/altar.js st()，这里只做形状修复（旧档缺字段补默认）
    if (s.altarState) {
      S.altarState = s.altarState;
      if (!Array.isArray(S.altarState.unlockedCamps)) S.altarState.unlockedCamps = [];
      if (!S.altarState.unlockedSlots) S.altarState.unlockedSlots = {};
      if (!S.altarState.enshrined) S.altarState.enshrined = {};
      if (!S.altarState.fameSynced) S.altarState.fameSynced = {};
    }
    // 通用商店：整块懒初始化在 handlers/shop.js st()，这里只做形状修复
    if (s.shopState) {
      S.shopState = s.shopState;
      if (!S.shopState.bought) S.shopState.bought = {};
    }
    // 图鉴：整块懒初始化+旧档回填在 handlers/handbook.js st()/backfill()（激活=获得过誓灵），这里只挂引用
    if (s.handbookState) S.handbookState = s.handbookState;
    // 银匙之门：整块懒初始化在 handlers/dream.js st()（含跨天重置），这里只做形状修复
    if (s.dreamState) {
      S.dreamState = s.dreamState;
      if (!S.dreamState.embattle) S.dreamState.embattle = {};
      if (!Array.isArray(S.dreamState.cleared)) S.dreamState.cleared = [];
      // 布阵引用了已不存在的誓灵（分解/替换）→ 清格，否则开战建单位时 find 不到直接少人
      for (const [pos, id] of Object.entries(S.dreamState.embattle)) {
        if (!S.servants.some(x => x.id === Number(id))) delete S.dreamState.embattle[pos];
      }
    }
    // 曜日副本：整块懒初始化在 handlers/daily_copy.js st()（含跨天次数重置），这里只做形状修复
    if (s.dailyCopyState) {
      S.dailyCopyState = s.dailyCopyState;
      if (!S.dailyCopyState.times) S.dailyCopyState.times = {};
      if (!Array.isArray(S.dailyCopyState.cleared)) S.dailyCopyState.cleared = [];
    }
    // 羁绊：整块懒初始化在 handlers/feeling.js st()（含每日重置），这里只做形状修复
    if (s.feelingState) {
      S.feelingState = s.feelingState;
      if (!S.feelingState.battleGain) S.feelingState.battleGain = {};
      if (!Array.isArray(S.feelingState.dormChecked)) S.feelingState.dormChecked = [];
      // 触摸（大厅立绘）每日计数：{count, sat, lastTs}，老档没有就补 0
      if (!S.feelingState.touch || typeof S.feelingState.touch !== 'object') {
        S.feelingState.touch = { count: 0, sat: 0, lastTs: 0 };
      }
    }
    // 主线首通奖励/双倍：整块懒初始化在 handlers/story_reward.js st()（含每日购买次数重置），这里只做形状修复
    if (s.exState) {
      S.exState = s.exState;
      if (!S.exState.used) S.exState.used = 0;
      if (!S.exState.day) S.exState.day = '';
    }
    if (s.storyState) {
      S.storyState = s.storyState;
      if (!Array.isArray(S.storyState.claimed)) S.storyState.claimed = [];
    }
    // 召唤：整块懒初始化在 handlers/summon.js st()（含跨天重置），这里只做形状修复
    if (s.summonState) {
      S.summonState = s.summonState;
      if (!S.summonState.pulls) S.summonState.pulls = {};
      if (!S.summonState.dayPulls) S.summonState.dayPulls = {};
      if (!S.summonState.freeUsed) S.summonState.freeUsed = {};
      if (!S.summonState.pity) S.summonState.pity = {};
      if (!Array.isArray(S.summonState.affinityGot)) S.summonState.affinityGot = [];
      if (!S.summonState.closed) S.summonState.closed = {};
    }
    // 信仰：plans 只做形状修复（FaithPlan 的默认 3 条由 handlers/faith.js 懒生成）
    if (s.faithState) {
      S.faithState = s.faithState;
      if (!Array.isArray(S.faithState.plans)) S.faithState.plans = [];
    }
    // 作战策略：形状修复（tactics/sort/applied 容器；modeId 越界回落默认 4/0）
    if (s.aiState) {
      S.aiState = s.aiState;
      if (!S.aiState.tactics || typeof S.aiState.tactics !== 'object') S.aiState.tactics = {};
      if (!Array.isArray(S.aiState.sort) || S.aiState.sort.length !== 6) S.aiState.sort = [1, 2, 3, 4, 5, 6];
      if (!S.aiState.applied || typeof S.aiState.applied !== 'object') S.aiState.applied = {};
      if (![4, 6].includes(Number(S.aiState.modeId))) { S.aiState.modeId = 4; S.aiState.modeValue = 0; }
      S.aiState.modeId = Number(S.aiState.modeId) || 4;
      S.aiState.modeValue = Number(S.aiState.modeValue) || 0;
      if (S.aiState.modeId === 4 && ![0, 1, 2].includes(S.aiState.modeValue)) S.aiState.modeValue = 0;
    }
    // 唤灵殿堂 + 成就：懒初始化在各自 handler 的 st()，这里只做形状修复
    if (s.dareState) {
      S.dareState = s.dareState;
      if (!Array.isArray(S.dareState.defeated)) S.dareState.defeated = [];
      if (!Array.isArray(S.dareState.claimedFirst)) S.dareState.claimedFirst = [];
      if (!S.dareState.claimedTiers) S.dareState.claimedTiers = {};
      if (!Array.isArray(S.dareState.gotItems)) S.dareState.gotItems = [];
      if (!S.dareState.spirit) S.dareState.spirit = {};
    }
    if (s.achvState) {
      S.achvState = s.achvState;
      if (!Array.isArray(S.achvState.claimed)) S.achvState.claimed = [];
      if (!S.achvState.counters) S.achvState.counters = {};
    }
    if (s.towerState) {
      S.towerState = s.towerState;
      if (!S.towerState.claimed) S.towerState.claimed = {};
      if (!Array.isArray(S.towerState.milestones)) S.towerState.milestones = [];
      if (!S.towerState.floorRecords) S.towerState.floorRecords = {};
    }
    // 塔战录像（回放/战果数据源；LRU 10 场，finishRecord 维护）
    if (s.towerRecords) {
      S.towerRecords = s.towerRecords;
      const dropped = scrubBadTowerRecords();
      if (dropped) log(`[tower] 存量录像自愈：丢弃 ${dropped} 场（回合帧引用了未宣告的单位）`);
    }
    // 新手引导：null = 老档（全部完成口径）；有值则补形状（done 数组/last 数字）
    if (s.guideState) {
      S.guideState = s.guideState;
      if (!Array.isArray(S.guideState.done)) S.guideState.done = [];
      S.guideState.last = Number(S.guideState.last) || 0;
    }
    // 元素精灵激活位（22）：老档没有 → 0；但若 done 里已有 122（例如从旧版本别的路径记过）视为已激活
    S.elementActivated = Number(s.elementActivated) || 0;
    if (!S.elementActivated && S.guideState && Array.isArray(S.guideState.done)
        && S.guideState.done.map(Number).includes(122)) S.elementActivated = 1;
    // 御灵士：整块懒初始化在 handlers/grow.js st()，这里只做形状修复（旧档缺字段补默认）
    if (s.growState) {
      S.growState = s.growState;
      if (!S.growState.stars) S.growState.stars = {};
      if (!S.growState.seen) S.growState.seen = {};
      S.growState.exp = Number(S.growState.exp) || 0;
      S.growState.weekExp = Number(S.growState.weekExp) || 0;
      S.growState.expFloat = Number(S.growState.expFloat) || 0;
    }
    // 言灵录：整块懒初始化在 handlers/moment.js st()（旧档为 null，首次判定时回填获得时间）
    if (s.momentState) S.momentState = s.momentState;
    if (s.actExtraState) S.actExtraState = s.actExtraState; // 活动扩展（act_extra.js 各活动子状态）
    if (s.signState) S.signState = s.signState; // 每日签到（活动 1001）
    if (S.signState.listId == null) S.signState.listId = 0;
    if (S.signState.days == null) S.signState.days = 0;
    if (S.signState.lastDay == null) S.signState.lastDay = '';
    if (s.collabState) {
      S.collabState = s.collabState;
      if (!S.collabState.plan) S.collabState.plan = { stars: {}, chapters: {}, claimedCh: {}, daily: {}, dailyDay: '' };
      if (!S.collabState.bili) S.collabState.bili = { fights: 0, kills: 0, grade: 0, lastKill: 0 };
      if (!S.collabState.dal) S.collabState.dal = { times: {}, cleared: [] };
      if (!S.collabState.selTeam) S.collabState.selTeam = {};
      if (!S.collabState.engine) S.collabState.engine = {};
    }
    // 加速引擎自愈：若商城已购加速引擎商品（3010/3011/3012/3013），自动恢复并激活对应引擎ID对
    if (s.shopState && s.shopState.bought) {
      const b = s.shopState.bought;
      if (b[3010] || b[3011] || b[3012] || b[3013]) {
        if (!S.collabState) {
          S.collabState = {
            day: '',
            plan: { stars: {}, chapters: {}, claimedCh: {}, daily: {}, dailyDay: '' },
            bili: { fights: 0, kills: 0, grade: 0, lastKill: 0 },
            dal: { times: {}, cleared: [] },
            selTeam: {},
            engine: {},
          };
        }
        if (!S.collabState.engine) S.collabState.engine = {};
        // 3010（1311/1314 加速引擎）已随活动 1311 下线（见 handlers/activity.js ACT_OPEN 注释）。
        // 老存档里买过 3010 的玩家，引擎权益要平移到保留下来的 1107：1311/1314 → 1107/1108，
        // 否则该玩家在 1107 面板上会显示"未激活"（买了却失效）。购买记录本身留在 shopState.bought 不动。
        if (b[3010]) { S.collabState.engine[1108] = 1; S.collabState.engine[1107] = 1; }
        if (b[3011]) { S.collabState.engine[1326] = 1; S.collabState.engine[1325] = 1; }
        if (b[3012]) { S.collabState.engine[1328] = 1; S.collabState.engine[1327] = 1; }
        if (b[3013]) { S.collabState.engine[1108] = 1; S.collabState.engine[1107] = 1; }
      }
    }
    if (s.levelRewardState) {
      S.levelRewardState = s.levelRewardState;
      if (!Array.isArray(S.levelRewardState.claimed)) S.levelRewardState.claimed = [];
    } else {
      S.levelRewardState = { claimed: [] };
    }
    if (s.actFavorState) {
      S.actFavorState = s.actFavorState;
      if (!Array.isArray(S.actFavorState.claimed)) S.actFavorState.claimed = [];
      if (!S.actFavorState.counters) S.actFavorState.counters = {};
      if (typeof S.actFavorState.favor !== 'number') S.actFavorState.favor = 0;
    } else {
      S.actFavorState = { favor: 0, claimed: [], is_helper: 0, counters: {} };
    }
    if (s.copyRewardState) {
      S.copyRewardState = s.copyRewardState;
      if (!Array.isArray(S.copyRewardState.claimed)) S.copyRewardState.claimed = [];
    } else {
      S.copyRewardState = { claimed: [] };
    }
    S.jumpState = s.jumpState || { max_score: 0, daily_score: 0, top_times: 0 };
    S.candyState = Object.assign({ remain: 200, buff_times: 0, protect_times: 20, rare: [], day: '', vitRem: 0 }, s.candyState || {});
    if (!Array.isArray(S.candyState.rare)) S.candyState.rare = [];
    if (S.candyState.protect_times == null || S.candyState.protect_times <= 0) S.candyState.protect_times = 20;
    if (S.candyState.remain == null || S.candyState.remain < 200) S.candyState.remain = 200;
    // 旧存档迁移：defeated/clearedCopies/droppedServants（单关卡）→ maps['1010100']
    if (!S.mapProgress.maps) {
      S.mapProgress = {
        maps: S.mapProgress.defeated || S.mapProgress.clearedCopies ? {
          1010100: {
            defeated: S.mapProgress.defeated || [],
            cleared: S.mapProgress.clearedCopies || [],
            dropped: S.mapProgress.droppedServants || [],
          },
        } : {},
      };
    }
    log(`[state] 读取存档：誓灵 ${S.servants.length} 只，关卡进度 keys=[${Object.keys(S.mapProgress.maps).join(',')}]`);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      log('[state] 无存档文件，使用初始状态');
    } else {
      log(`[state] 载入存档异常，回落默认状态: ${e && (e.stack || e.message || String(e))}`);
    }
    S.mapProgress = { maps: {} };
  }
  S.servants.forEach(b => {
    require('./data/chaos_data').normalize(b);
    if (!Array.isArray(b.learned_skills)) b.learned_skills = [];
    if (b.relic_gid == null) b.relic_gid = 0;       // 已装备圣器（物品 gid；0=未携带）
    if (b.element_gid == null) b.element_gid = 0;   // 已装备元素精灵（物品 gid；0=未携带）
    if (!b.cores) b.cores = {};                     // 已装备能力核心 {属性码1-6: 物品 gid}
    // 信仰装备态（handlers/faith.js）：faiths={pos1..9: 物品 gid}（誓灵本体套装）、
    // faithTeams={teamId: {pos: gid}}（各编队的独立套装）。旧存档无此字段 → 补空
    if (!b.faiths) b.faiths = {};
    if (!b.faithTeams) b.faithTeams = {};
    // 装备技能 3 槽（技能页签 listEquip）：0=空槽。旧存档无此字段 → 默认装技能书 lv=0 自带技
    //（必须恰好 3 元素：客户端 LuaDataProvider 直接用它渲染 A/B/C 槽，空数组=整栏不显示）
    if (!Array.isArray(b.using_skills) || b.using_skills.length !== 3) {
      const defs = require('./data/fight_core').defaultSkills(b.type);
      b.using_skills = [defs[0] || 0, defs[1] || 0, defs[2] || 0];
    } else {
      b.using_skills = b.using_skills.map(Number).slice(0, 3);
      while (b.using_skills.length < 3) b.using_skills.push(0);
    }
    // 作战策略「自行」技能循环（p_servant_detail.ai_skills 同名字段，detail 构造 Object.assign 直通）：
    // [技能id...] 优先级序，最长 9（SkillChoiceConst.skillMaxNum）；0=空槽占位
    if (!Array.isArray(b.ai_skills)) b.ai_skills = [];
    else b.ai_skills = b.ai_skills.map(Number).filter(n => n >= 0).slice(0, 9);
    // 能源（强化页签）：ceils 旧存档补初始上限 6/属性；points 默认空（全 0）
    const ED = require('./data/energy_data');
    if (!b.energy_ceils) b.energy_ceils = ED.ENERGY_PROPS.reduce((o, p) => (o[p] = ED.ENERGY_INIT_CEIL, o), {});
    if (!b.energy_points) b.energy_points = {};
  });
  // ---- 一次性迁移 starBase2：占位 5 星 → 官方出生星级 2 ----
  // 进化（升星）实装前，makeServantBrief 把 star 写死 5（MAX_START）来让客户端 canEvolution 短路，
  // 避开查 starItems[typeId][5] 得 nil 再比 nil.cost 的崩溃。那是占位值不是玩家挣来的星级：
  // 留着会让每只誓灵一出生就满星，进化面板恒显示"已达最高星"、三阶进化皮直接白送。
  // 迁移把全员夹回 BASE_STAR=2，并清掉因此变成"未拥有"的进化皮（getWayID 3/4/5）。
  // migrations.starBase2 记标记 → 之后玩家真进化出来的 3/4/5 星不会被再动一次。
  if (!S.migrations.starBase2 && S.servants.length) {
    const EV = require('./data/evolution_rules');
    let n = 0, skinFix = 0;
    let SKIN_TYPES = {};
    try { SKIN_TYPES = JSON.parse(fs.readFileSync(path.join(__dirname, 'skin_config.json'), 'utf8')).types || {}; } catch (e) { /* 无皮肤表则只降星 */ }
    S.servants.forEach(b => {
      if (Number(b.star) === EV.BASE_STAR) return;
      b.star = EV.BASE_STAR;
      n++;
      const entry = (SKIN_TYPES[b.type] || []).find(sk => sk.skinID === Number(b.skin_id));
      if (entry && entry.getWayID >= 3 && entry.getWayID <= 5) {
        const base = (SKIN_TYPES[b.type] || []).find(sk => sk.getWayID === 0);
        if (base) { b.skin_id = base.skinID; skinFix++; }
      }
    });
    S.migrations.starBase2 = true;
    log(`[state] 迁移 starBase2：${n} 只誓灵星级占位值 5 → ${EV.BASE_STAR}（进化皮回落 ${skinFix} 只）`);
  }
  // ---- 一次性迁移 scoreItems：背包里的「道具形态积分」并回 role_scores ----
  // 客户端这类道具（CfgScoreItem ∩ CfgItems.form=2，如 31000009 协会点数、31000016 唤灵碎块）的
  // 持有数一律读 GlobalData.getScore(scoreId)，且 form=2 不在背包页签显示（ItemConfig.isToBag 只认 1/3）。
  // 历史版本在任务/曜日/砸罐子/礼包等发放路径把它们当普通物品入包 → 玩家"拿到了却没涨"且背包看不见
  //（2026-09-10 协会点真机反馈）。此处把存量并回积分，幂等；发放侧已由 lib.grantScoreItem 统一拦截。
  if (!S.migrations.scoreItems) {
    const { ITEM_TO_SCORE } = require('./data/score_items');
    if (!S.roleAsset.scores) S.roleAsset.scores = {};
    const kept = [];
    const moved = [];
    for (const g of S.bagGoods) {
      const sid = ITEM_TO_SCORE[Number(g.type_id)];
      if (sid) {
        S.roleAsset.scores[sid] = (Number(S.roleAsset.scores[sid]) || 0) + (Number(g.cur_num) || 0);
        moved.push(`${g.type_id}×${g.cur_num}→积分${sid}`);
      } else kept.push(g);
    }
    S.bagGoods = kept;
    S.migrations.scoreItems = true;
    if (moved.length) log(`[state] 迁移 scoreItems：${moved.join(' ')}（背包存量并入 role_scores）`);
  }
  // ---- 幽灵货币条目清偿（二百八十四）----
  // grantMissionRewards（任务/活跃度宝箱/月签到/act_extra 首通）与 family 贡献奖励早年缺
  // 30000002 体力分支，金币/水晶/体力（CfgItems form=2 货币族）掉进 grantGoods 变成 bagGoods
  // 条目，而客户端 m_goods_update_toc 的 isToBag(form=2)=false 闸门把 op=3 静默丢弃 ⇒
  // 玩家"领了不增加"、存档里躺着永远不可见的假道具（本机实测 30000002×1550）。
  // 发奖侧修复后不再产生新条目，本块每次空转、天然幂等（二百七十九口径，不设 migrations 门，
  // 兼作未来同类回归的持续防线）。清偿口径：这些条目从未到过玩家手里，按各自资产语义补账
  // （体力=role_scores[5]，登录链 onLogin 推 m_vit_update_toc，此处无需 conn）；
  // 30000001 御灵士经验不补——applyRoleExpGain 需要 conn/升级推送时机，历史存量仅零星个位数。
  {
    const CREDIT = {
      30000002: n => {
        if (!S.roleAsset.scores) S.roleAsset.scores = {};
        S.roleAsset.scores[5] = Math.max(0, Number(S.roleAsset.scores[5]) || 0) + n;
      },
      30000000: n => { S.roleAsset.gold += n; S.roleAsset.gold_given += n; },
      30000003: n => { S.roleAsset.silver += n; },
      // 御灵士经验（applyRoleExpGain 需要 conn/升级推送时机，历史存量仅零星个位数）：只清不补
      30000001: () => {},
    };
    let dropped = 0;
    const credited = {};
    S.bagGoods = S.bagGoods.filter(g => {
      const t = Number(g.type_id);
      if (!CREDIT[t]) return true;
      const n = Math.max(0, Math.floor(Number(g.cur_num) || 0));
      if (n > 0) CREDIT[t](n);
      credited[t] = (credited[t] || 0) + n;
      dropped++;
      return false;
    });
    if (dropped) {
      const desc = Object.entries(credited).map(([t, n]) =>
        `${t}×${n}${t === '30000002' ? '（补回体力）' : t === '30000001' ? '（不补账）' : '（补回资产）'}`).join('，');
      log(`[state] 清偿幽灵货币条目 ${dropped} 个（${desc}）——form=2 货币曾误入背包，客户端静默丢弃`);
      dirtySave = true;
    }
  }
  // ---- 一次性迁移 elementBag：元素精灵 / 元素晶石归位到 bag 9 + 拆成实例 + 补实例字段 ----
  // 三个必须做的理由（2026-10-23 元素精灵接通）：
  //  1. 客户端三个元素选人面板只读 BagMgr.getItems(BAG_TYPE_ELEMENT=9)，晶石留在材料包选不到；
  //  2. 旧 grantGoods 把 71000001 按 type_id 堆叠 → 一个实例 cur_num=N，而每个实例必须独立带
  //     level/translate_type/face（堆叠实例的 level 是 0 ⇒ 融合页 getMergeLvVO(0)=nil 崩）；
  //  3. 已在活动积分/掉落/兑换表里发放过，存量必须补齐 spec 字段。
  if (!S.migrations.elementBag) {
    const ELD = require('./data/element_data');
    const isElemType = t => {
      const p = String(Number(t) || 0).slice(0, 2);
      return p === '71' || p === '72';
    };
    const out = [];
    let moved = 0, split = 0, filled = 0;
    for (const g of S.bagGoods) {
      if (!isElemType(g.type_id)) { out.push(g); continue; }
      if (Number(g.bag_type) !== 9) { g.bag_type = 9; moved++; }
      // ⚠️ 字段补齐必须在**拆实例之前**：拆出来的副本是浅拷贝，先拆后补会让副本留着 level=0
      // （客户端融合页 getMergeLvVO(0)=nil → 崩），本轮冒烟抓到过一次。
      if (!Number(g.level)) { g.level = 1; filled++; }
      if (g.translate_type == null) g.translate_type = 0;
      if (g.translate_times == null) g.translate_times = 0;
      if (!Array.isArray(g.face) || g.face.length !== 3) {
        g.face = [{ id: 1, val: 1 }, { id: 2, val: 1 }, { id: 3, val: 1 }];
      }
      if (!Number(g.color)) {
        g.color = Number(g.translate_type) > 0 ? ELD.CRYSTAL_COLOR : ELD.NORMAL_ITEM_COLOR;
      }
      const n = Math.max(1, Number(g.cur_num) || 1);
      if (n > 1) {
        g.cur_num = 1;
        for (let i = 1; i < n; i++) out.push(Object.assign({}, g, { id: S.nextGoodsId++ }));
        split += n - 1;
      }
      out.push(g);
    }
    S.bagGoods = out;
    S.migrations.elementBag = true;
    if (moved || split || filled) {
      log(`[state] 迁移 elementBag：${moved} 件归位 bag_type=9，拆出 ${split} 个实例，${filled} 件补 level=1`);
      dirtySave = true;
    }
  }
  // 旧存档迁移：圣器/核心（canPile=false）曾被按 type_id 堆叠发放——拆成单实例（装备引用 gid）
  {    const RD = require('./data/relic_data');
    const split = [];
    S.bagGoods = S.bagGoods.filter(g => {
      if ((RD.isRelicType(g.type_id) || RD.isCoreType(g.type_id)) && Number(g.cur_num) > 1) {
        for (let i = 1; i < Number(g.cur_num); i++) {
          split.push({ id: S.nextGoodsId++, type_id: g.type_id, cur_num: 1, bag_type: g.bag_type, level: 1 });
        }
        g.cur_num = 1;
      }
      if ((RD.isRelicType(g.type_id) || RD.isCoreType(g.type_id)) && !g.level) g.level = 1;
      if (RD.isRelicType(g.type_id)) RD.normalizeEnchant(g);
      return true;
    });
    if (split.length) { S.bagGoods.push(...split); log(`[state] 圣器/核心堆叠迁移：拆出 ${split.length} 个实例`); }
    // 装备引用了已不在包内的物品 → 清装备态（防 detail 下发悬空 gid）
    S.servants.forEach(b => {
      if (b.relic_gid && !S.bagGoods.some(g => Number(g.id) === Number(b.relic_gid))) b.relic_gid = 0;
      // 元素精灵（bag_type 9）：索引里没有该 gid → 视为未携带
      if (b.element_gid && !S.bagGoods.some(g => Number(g.id) === Number(b.element_gid))) b.element_gid = 0;
      for (const k of Object.keys(b.cores || {})) {
        if (!S.bagGoods.some(g => Number(g.id) === Number(b.cores[k]))) delete b.cores[k];
      }
      // 信仰：本体套装 + 各编队套装的悬空 gid 一并清
      for (const p of Object.keys(b.faiths || {})) {
        if (!S.bagGoods.some(g => Number(g.id) === Number(b.faiths[p]))) delete b.faiths[p];
      }
      for (const t of Object.keys(b.faithTeams || {})) {
        const slots = b.faithTeams[t] || {};
        for (const p of Object.keys(slots)) {
          if (!S.bagGoods.some(g => Number(g.id) === Number(slots[p]))) delete slots[p];
        }
        if (!Object.keys(slots).length) delete b.faithTeams[t];
      }
    });
  }
  // 初始誓灵自动发放：仅限**非引导**档（guideState=null 的老档/无引导新档）。
  // 引导档（useAccount 新建时 guideState={done:[],last:0}）必须从 0 誓灵起步——
  // 官方流程是首战教学（客户端脚本）→ 选灵（m_servant_select_tos 发 1 只）→ 召唤引导，
  // 预先发满 3 只会让"选灵"失去意义且编队/图鉴状态错乱。
  if (S.servants.length === 0 && !S.guideState) {
    // 延迟 require：state ↔ handlers/servant 循环依赖，调用时模块已加载完成
    const { makeServantBrief } = require('./handlers/servant');
    for (const t of STARTER_TYPES) { const b = makeServantBrief(t); if (b) S.servants.push(b); }
  }
  // 协会初始摆设/仓库/建筑（旧存档迁移：空则补默认）
  // defaultDormFurnitures/DEFAULT_WAREHOUSE 定义在 handlers/dorm.js——延迟 require 解循环依赖
  //（调用时模块已加载完成；2026-08-22 修复：此前直接调用未定义符号，空 dormState 存档会 ReferenceError）
  const { defaultDormFurnitures, DEFAULT_WAREHOUSE, ensureSpecialFurniture } = require('./handlers/dorm');
  if (S.dormState.furnitures.length === 0) S.dormState.furnitures = defaultDormFurnitures();
  if (Object.keys(S.dormState.warehouse).length === 0) S.dormState.warehouse = Object.assign({}, DEFAULT_WAREHOUSE);
  // 售货机两台（90000/90001，canAdd=false 只能预摆）：老档按 type_id 查重补摆（二百八十三）
  try { if (ensureSpecialFurniture() > 0) dirtySave = true; } catch (e) { log('[state] ensureSpecialFurniture 跳过:', e.message); }
  // 誓灵编队状态 team_ids 同步自愈（延迟 require 解循环依赖）
  if (Array.isArray(S.servants) && S.servants.length > 0 && S.formations) {
    try {
      const { syncServantTeamIds } = require('./handlers/servant');
      if (typeof syncServantTeamIds === 'function') {
        const changed = syncServantTeamIds();
        if (changed.length > 0) dirtySave = true;
      }
    } catch (e) {
      log('[state] syncServantTeamIds 自愈跳过:', e.message);
    }
  }
  // 一次性迁移 unlockAutoLockedNR：解除此前抽卡/获取导致 N/R 级誓灵被误自动锁定的历史存量数据
  if (!S.migrations.unlockAutoLockedNR) {
    let unlocked = 0;
    if (Array.isArray(S.servants)) {
      for (const s of S.servants) {
        const color = Math.floor(Number(s.type) / 10000) % 10;
        if (color <= 2 && (Number(s.status) & 1) === 1) {
          s.status = Number(s.status) & ~1;
          unlocked++;
        }
      }
    }
    S.migrations.unlockAutoLockedNR = true;
    if (unlocked > 0) {
      dirtySave = true;
      log(`[state] 迁移 unlockAutoLockedNR：已解除 ${unlocked} 只被误自动锁定的 N/R 誓灵锁定标记`);
    }
  }
  // 派遣位（status bit2 = 4）自愈：以 dormState.troops 为唯一真相源。
  // 2026-10-23（派遣系统落地）起派遣会真置 status|=4；旧存档里可能残留"没有对应队伍却带派遣位"
  // 的历史脏数据（实测 90000001 status=12 就是队都不在却仍标着派遣/战斗）。
  // 不清掉的话这些誓灵会被 m_building_crusade_dispatch_tos 的 206001 永久拒绝，玩家无从自救。
  if (Array.isArray(S.servants) && S.dormState) {
    const inTroop = new Set();
    for (const t of S.dormState.troops || []) {
      for (const id of t.servant_ids || []) inTroop.add(Number(id));
    }
    let cleared = 0, restored = 0;
    for (const s of S.servants) {
      const cur = Number(s.status) || 0;
      const has = (cur & 4) === 4;
      const want = inTroop.has(Number(s.id));
      if (has && !want) { s.status = cur & ~4; cleared++; }
      else if (!has && want) { s.status = cur | 4; restored++; } // 队伍在册但位丢了（旧版派遣/手工改档）
    }
    if (cleared || restored) {
      dirtySave = true;
      log(`[state] 派遣位自愈：清除 ${cleared} 只无队伍的派遣标记，补回 ${restored} 只在册队伍的派遣标记`
        + `（troops=${(S.dormState.troops || []).length} 队）`);
    }
  }
  // 战斗位（status bit3 = 8，客户端 ServantUtil.getIntNBit(x,4)——isBattle/isBattleNow 判定源）
  // 自愈（二百八十二·续 E）：真相源 = mapState（会话级不落盘）。服务重启发生在关卡中途时位 8
  // 可能已随存档落盘，而重启后 mapState 恒 null ⇒ 全量清除。运行期由 init_barrier 置位 /
  // pushTeamReset 清位（key:3 推送驱动客户端 VO.status）。与派遣位同形状。
  if (Array.isArray(S.servants)) {
    let clearedBattle = 0;
    for (const s of S.servants) {
      const cur = Number(s.status) || 0;
      if ((cur & 8) === 8) { s.status = cur & ~8; clearedBattle++; }
    }
    if (clearedBattle) {
      dirtySave = true;
      log(`[state] 战斗位自愈：清除 ${clearedBattle} 只残留的"战斗中"标记（重启后地图会话已不存在）`);
    }
  }
  // 休息位（status bit9 = 512）自愈（二百七十四）：以 dormState.servants 为唯一真相源，形状同上。
  // isDormRest = BitUtil.getIntNBit(status,10)（1-indexed 自 LSB）→ 值 2^9=512；
  // 主城收集图标 DormMgr.getDormRewardServants 只数 isDormRest 的誓灵，缺位 = 气泡永不亮。
  if (Array.isArray(S.servants) && S.dormState) {
    const resting = new Set((S.dormState.servants || []).map(r => Number(r.servant_id)));
    let clearedR = 0, restoredR = 0;
    for (const sv of S.servants) {
      const cur = Number(sv.status) || 0;
      const has = (cur & 512) === 512;
      const want = resting.has(Number(sv.id));
      if (has && !want) { sv.status = cur & ~512; clearedR++; }
      else if (!has && want) { sv.status = cur | 512; restoredR++; }
    }
    if (clearedR || restoredR) {
      dirtySave = true;
      log(`[state] 休息位自愈：清除 ${clearedR} 只已离位誓灵的休息标记，补回 ${restoredR} 只在位誓灵`
        + `（入住 ${(S.dormState.servants || []).length} 只）`);
    }
  }
  // 自律派遣自愈（二百六十八）：只留一份在跑/待领的记录
  //  · 已领奖且超过 10 分钟 → 清掉（结算明细/录像占存档体积）
  //  · finished 但没有 results（旧版/半途崩）→ 退回未结算，领奖时重跑
  //  · 缺 points / end_time 非法 → 整条丢弃（宁可让玩家重派，不要让领奖永远 210002）
  if (S.dormState && S.dormState.auto) {
    const a = S.dormState.auto;
    const nowSec = Math.floor(Date.now() / 1000);
    const bad = !a.barrier_id || !a.team_ids || !Array.isArray(a.team_ids) || !a.team_ids.length
      || !Number.isFinite(Number(a.end_time)) || !Number(a.times);
    if (bad) {
      S.dormState.auto = null;
      dirtySave = true;
      log('[state] 自律派遣自愈：记录不完整（缺 barrier/team/end_time/times），已清除');
    } else if (a.claimed && nowSec - Number(a.claim_time || 0) > 600) {
      S.dormState.auto = null;
      dirtySave = true;
      log('[state] 自律派遣自愈：已领奖超过 10 分钟，清理结算明细与录像');
    } else if (Number(a.finished) && !Array.isArray(a.results)) {
      a.finished = 0;
      dirtySave = true;
      log('[state] 自律派遣自愈：finished 无 results → 退回未结算（领奖时重跑）');
    }
  }
  // 编队内誓灵状态历史缓存自愈（同步 S.formations[idx].servants 的 status 与 status2 为誓灵真实状态）
  if (S.formations && typeof S.formations === 'object' && Array.isArray(S.servants)) {
    let formationStatusSynced = 0;
    for (const idx of Object.keys(S.formations)) {
      const f = S.formations[idx];
      if (f && Array.isArray(f.servants)) {
        for (const sv of f.servants) {
          if (!sv || !sv.id) continue;
          const master = S.servants.find(s => s && s.id === sv.id);
          if (master) {
            const masterStatus = Number(master.status) || 0;
            const masterStatus2 = Number(master.status2) || 0;
            if (sv.status !== masterStatus || sv.status2 !== masterStatus2) {
              sv.status = masterStatus;
              sv.status2 = masterStatus2;
              formationStatusSynced++;
              dirtySave = true;
            }
          }
        }
      }
    }
    if (formationStatusSynced > 0) {
      log(`[state] 编队缓存自愈：已同步 ${formationStatusSynced} 只编队内誓灵的锁定/二级状态`);
    }
  }
  // 一次性迁移 scrubDanglingServantRefs：清掉历史存档里指向已不存在誓灵的悬空引用
  //（编队四数组/爬塔队/探索队/看板娘——喂食清引用修复前吃掉誓灵会留下悬空 id）。
  // 悬空 id 随 p_formation.fight_field 下发后，客户端结算面板 CopyRewardServantItem.onGUI
  // 建卡 roster 查无 → LuaError "attempt to index a nil value"（其他玩家实测报错，2026-10-01）
  if (!S.migrations.scrubDanglingServantRefs) {
    try {
      const alive = new Set((S.servants || []).map(s => Number(s.id)));
      const referenced = new Set();
      const take = arr => { for (const id of (Array.isArray(arr) ? arr : [])) { const n = Number(id); if (n > 0) referenced.add(n); } };
      for (const f of Object.values(S.formations || {})) {
        for (const k of ['field', 'bench', 'fight_field', 'fight_bench']) take(f && f[k]);
      }
      const tw = S.towerState && S.towerState.team;
      if (tw && tw.slots) for (const slot of Object.keys(tw.slots)) take([tw.slots[slot]]);
      for (const list of Object.values((S.arkState && S.arkState.teams) || {})) take(list);
      take(S.helperIdList || []);
      const dead = [...referenced].filter(id => !alive.has(id));
      if (dead.length) {
        const { scrubServantRefs } = require('./handlers/servant');
        const n = scrubServantRefs(dead);
        if (n > 0) { dirtySave = true; log(`[state] 迁移 scrubDanglingServantRefs：清掉 ${n} 处指向已不存在誓灵的悬空引用（${dead.join(',')}）`); }
      }
    } catch (e) {
      log('[state] scrubDanglingServantRefs 迁移跳过:', e.message);
    }
    S.migrations.scrubDanglingServantRefs = true;
  }
  // 一次性迁移 bossPointOfficial：16 关「最后一战」的 copy_id 从本地顺推号改为官方 BOSS 副本号
  //（见工作日志 二百零二）。通关判定是 `cleared 含 cfg.bossPoint`，改号后老存档里的旧号
  // 不再命中 → 已通关的关会回退成未通关、章节解锁链断裂、首通奖励图标重新亮起。
  // 这里把旧号就地替换成新号（含 `defeated` 之外的 cleared 数组；dropped/defeated 是怪物格，不动）。
  // OLD→NEW 是改号前的固定历史映射，不随后续配置变化，故写死。
  if (!S.migrations.bossPointOfficial) {
    const BOSS_POINT_RENAMED = {
      1010203: 1010204,
      1050105: 1050107, 1050205: 1050207, 1050305: 1050307, 1050406: 1050408,
      1060206: 1060208, 1060306: 1060308,
      1070106: 1070108,
      1080106: 1080108, 1080206: 1080208,
      1090106: 1090108, 1090206: 1090208, 1090306: 1090308, 1090406: 1090408,
      1100206: 1100208, 1100406: 1100408,
    };
    let renamed = 0;
    try {
      for (const map of Object.values((S.mapProgress && S.mapProgress.maps) || {})) {
        if (!map || !Array.isArray(map.cleared)) continue;
        const next = map.cleared.map(id => {
          const to = BOSS_POINT_RENAMED[Number(id)];
          if (to) renamed++;
          return to || id;
        });
        map.cleared = [...new Set(next)];
      }
    } catch (e) {
      log('[state] bossPointOfficial 迁移跳过:', e.message);
    }
    if (renamed > 0) {
      dirtySave = true;
      log(`[state] 迁移 bossPointOfficial：${renamed} 处通关记录改用官方 BOSS 副本号`);
    }
    S.migrations.bossPointOfficial = true;
  }
  // 敌方伪誓灵自愈（按类型、幂等、**每次 load 都跑**——不设 migrations 门，防未来任何路径漏网后再污染；
  // 见 调研-GM一键获取誓灵带出敌方伪誓灵.md）：这 6 只官方仅敌人（尤格/莎布/奈亚/克苏/辛西娅/杂鱼光）
  // 客户端无 starItems/图鉴/凭证配置，持有即坏誓灵小屋红点链（canEvolution → pairs(nil)）。
  // 只删"CfgServant 认识但不可持有"的 6 只；完全不认识的 type 不在此删（briefableServants 出口过滤 + 上游建卡守卫负责）。
  if (S.servants && S.servants.length) {
    const bad = S.servants.filter(b => ST_ENEMY.isEnemyOnlyServantType(b && b.type));
    if (bad.length) {
      const ids = bad.map(b => Number(b.id));
      const refs = require('./handlers/servant').scrubServantRefs(ids);
      const before = S.servants.length;
      S.servants = S.servants.filter(b => !ST_ENEMY.isEnemyOnlyServantType(b.type));
      dirtySave = true;
      log(`[state] 自愈敌方伪誓灵：删除 ${before - S.servants.length} 只（type=${bad.map(b => b.type).join('/')}，id=${ids.join('/')}），清 ${refs} 处编队/塔/方舟/看板娘/协会引用`);
    }
  }
  if (dirtySave) {
    saveState();
    log('[state] 脏数据清洗完毕，已自动落盘');
  }
}

function saveState(opts) {
  if (batchDepth > 0) { // 事务内：只记脏，退出时统一落盘（见 batchWrites）
    batchDirty = true;
    return;
  }
  if (opts && opts.defer && !(opts.force)) {
    pendingSave = true;
    if (!pendingSaveTimer) {
      pendingSaveTimer = setTimeout(() => {
        pendingSaveTimer = null;
        if (pendingSave) { pendingSave = false; saveState({ force: true }); }
      }, Math.max(10, Number(opts.delay) || 50));
    }
  }
  if (opts && opts.defer && !(opts.force)) return;
  try {
    const payload = JSON.stringify({ servants: S.servants, helperIdList: S.helperIdList, formations: S.formations, bagSizes: S.bagSizes, servantBagSize: S.servantBagSize || 100, mapProgress: S.mapProgress, dormState: S.dormState, skinState: S.skinState, helperState: S.helperState, themeState: S.themeState, medalState: S.medalState, mainAppLayout: S.mainAppLayout, nextServantId: S.nextServantId, bagGoods: S.bagGoods, nextGoodsId: S.nextGoodsId, musicState: S.musicState, jumpState: S.jumpState, candyState: S.candyState, roleAsset: S.roleAsset, theaterState: S.theaterState, missionState: S.missionState, familyState: S.familyState, vitState: S.vitState, lineupState: S.lineupState, arkState: S.arkState, altarState: S.altarState, shopState: S.shopState, handbookState: S.handbookState, dreamState: S.dreamState, dailyCopyState: S.dailyCopyState, exState: S.exState, storyState: S.storyState, feelingState: S.feelingState, summonState: S.summonState, dareState: S.dareState, achvState: S.achvState, towerState: S.towerState, towerRecords: S.towerRecords, guideState: S.guideState, elementActivated: S.elementActivated || 0, growState: S.growState, momentState: S.momentState, actExtraState: S.actExtraState, signState: S.signState, collabState: S.collabState, levelRewardState: S.levelRewardState, actFavorState: S.actFavorState, copyRewardState: S.copyRewardState, faithState: S.faithState, aiState: S.aiState, letterState: S.letterState, titleState: S.titleState, artworkState: S.artworkState, headState: S.headState, showTeamState: S.showTeamState, profileIntro: S.profileIntro, migrations: S.migrations, roleName: S.roleName });
    const dir = path.dirname(stateFile);
    fs.mkdirSync(dir, { recursive: true });
    // 同一事件链中多个 handler 可能重复调用 saveState；内容未变化时跳过重复同步写入。
    // 内容变化仍走临时文件、备份和原子替换，目标文件被删除时也不会误跳过。
    if (lastPersistedFile === stateFile && lastPersistedPayload === payload && fs.existsSync(stateFile)) return;
    const tmp = stateFile + '.tmp';
    const backup = stateFile + '.bak';
    fs.writeFileSync(tmp, payload, 'utf8');
    if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, backup);
    try {
      // Windows 不允许 rename 覆盖现有文件，先保留 .bak，再替换目标。
      fs.rmSync(stateFile, { force: true });
      fs.renameSync(tmp, stateFile);
      lastPersistedFile = stateFile;
      lastPersistedPayload = payload;
    } catch (e) {
      if (!fs.existsSync(stateFile) && fs.existsSync(backup)) fs.copyFileSync(backup, stateFile);
      throw e;
    }
  } catch (e) {
    log('[state] 存档失败', e.message);
    if (opts && opts.throwOnError) throw e; // 扣料事务必须能在持久化失败时回滚
  }
}

function flushSave() {
  if (pendingSaveTimer) { clearTimeout(pendingSaveTimer); pendingSaveTimer = null; }
  if (pendingSave) { pendingSave = false; saveState({ force: true }); }
}

// 结算事务：fn 执行期间所有 saveState 合并为一次（退出时 flush）。
// 目的不是省磁盘，而是**不把同步 fsync 插进成对推送之间**——真机单次写盘 500~950ms，
// 结算包与 scene_result 之间夹一次写盘就会让客户端误报「网络问题战斗结果没收到」。
// 返回 fn 的返回值；fn 抛错时仍会落盘（状态可能已被部分修改，宁可多写一次）。
function batchWrites(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && batchDirty) {
      batchDirty = false;
      saveState({ force: true });
    }
  }
}

// ---- 多账号：切换当前存档 ----
// 返回 {switched, created}；switched=false 表示本来就是这个账号（重连/重复登录），什么都没动。
function useAccount(acc) {
  const ACC = require('./accounts');
  if (!acc) return { switched: false, created: false };
  if (currentAccount && String(currentAccount.name).toLowerCase() === String(acc.name).toLowerCase()) {
    currentAccount = acc; // token 可能已轮换，换成最新记录
    return { switched: false, created: false };
  }
  if (currentAccount) {
    saveState(); // 先把上一个账号的进度落盘，再换文件——顺序反了会把 A 的数据写进 B 的档
    log(`[account] 存档落盘：${currentAccount.name}`);
  }
  const file = ENV_STATE_FILE || ACC.saveFileOf(acc);
  const created = !fs.existsSync(file);
  flushSave();
  resetState();
  currentAccount = acc;
  stateFile = file;
  lastPersistedFile = null;
  lastPersistedPayload = null;
  // ⚠️ 引导档标记必须在 loadState() **之前**置位：loadState 的"0 誓灵 → 发 3 只初始誓灵"
  // 兜底按 S.guideState 判定（引导档从 0 只起步，靠选灵发第一只）。放在 loadState 之后
  // 会先发 3 只再标记，表现为新账号一进游戏就有 3 只誓灵、选灵重复给第 4 只（真机探针实证）。
  // 新建档读不到文件走 loadState 的 catch 分支，不会覆盖这里的预置值。
  if (created) S.guideState = { done: [], last: 0 };
  loadState();
  if (created) {
    S.roleName = acc.name; // 新账号：角色名默认取账号名（旧档保持存档里的名字）
    // 注册时刻（信件 72h 判定的锚点）+ 信箱/称号容器（调研-固定邮件两封）。
    // 欢迎信不在这里插：letter.onLogin（登录链）按 30 分钟窗口补投，此函数只负责记账。
    S.letterState = { createTime: Date.now(), nextId: 1, letters: [], welcome1Sent: 0, welcome2Sent: 0 };
    S.titleState = { owned: {}, usePre: 0, useSuf: 0 };
    // 补 1 张约定之契：组 8 召唤引导要点"单次召唤"（召唤池 31000004 计价；
    // 就算没券，池配置 isAutoBuy 也会用 50 金币代购，这里给券是双保险）。
    S.bagGoods.push({ id: S.nextGoodsId++, type_id: 31000004, cur_num: 1, bag_type: 1 });
    const GD = require('./data/guide_data');
    log(`[account] 新建引导档：0 誓灵起步（选灵发第一只），未完成引导 ${GD.FRESH_UNFINISHED.length} 组，赠约定之契 ×1`);
    saveState();
  }
  log(`[account] 当前账号 → ${acc.name}（${created ? '新建存档' : '读取存档'} ${path.basename(file)}）`);
  return { switched: true, created };
}

const currentAccountName = () => (currentAccount ? currentAccount.name : '');
const getStateFile = () => stateFile;

module.exports = { S, STATE_FILE, MISSIONS, STARTER_TYPES, loadState, saveState, flushSave, batchWrites,
  resetState, useAccount, currentAccountName, getStateFile, scrubBadTowerRecords,
  get servantBagSize() { return S.servantBagSize || 100; } };

