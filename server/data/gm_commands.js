// GM 指令注册表（2026-10-21 二百零二 / P1）
//
// 为什么单独一个文件：`handlers/role.js` 的 `gmDispatch` 是一条 700 行的 if 链，53 条指令
// 各自 require + 各自 saveState，任何一处漏解构只有点到那条才炸（E5：VALID_ITEM_TYPES 事故）。
// P1 起**新指令一律登记在这里**，由 `handlers/gm.js` 统一执行（解析/校验/异常隔离/回执），
// 老分支暂不搬迁（避免一次性重写 700 行带来的回归风险，见方案文档 §0.5 的说明）。
//
// 条目契约：
//   name   中文名（回执与 m21_h 列表用）
//   args   给人看的参数说明（"=数量" / "=ID=数量"）
//   run(ctx, parts) → { ok:true, msg } | { ok:false, msg } ；也可返回 undefined 表示成功但无细节
//   ctx = { conn, S, L, log, save(), ok(msg), fail(msg), extraNames }
//
// 纪律：
//   ① 一律走既有业务函数（grantGoods / grantServantBrief / pushXxx / saveState），不直接改协议；
//   ② 批量操作必须**分段回执**（"等级✓ 星级✓ 突破✗"），不要只回一个"已执行"；
//   ③ 破坏性指令必须**两步确认**（`=1` 只统计，`=2` 才真做），单机存档不允许一键误删。
const { MISSIONS } = require('../state');
const { VALID_SERVANT_TYPE_LIST, UNOBTAINABLE_SERVANT_TYPES, isObtainableServantType } = require('./servant_types');

const MAXTXT = 180;  // 回执单行上限，超出截断（客户端 Alert 是一段文本）

function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

module.exports = {
  // ---------------- 货币 / 功能 ----------------
  'm21_score': {
    name: '增加积分', args: '=<积分ID>=<数量>',
    run(ctx, p) {
      const id = parseInt(p[1]), n = parseInt(p[2]);
      if (!id || !Number.isFinite(n)) return ctx.fail('用法 m21_score=<积分ID>=<数量>');
      ctx.L.addScore(ctx.conn, id, n);
      ctx.save();
      return ctx.ok(`积分 ${id} → ${ctx.L.getScore(id)}`);
    },
  },
  'm21_function': {
    name: '开启所有功能', args: '=1 全开 / =0 恢复按进度',
    run(ctx, p) {
      const on = (parseInt(p[1]) || 0) ? 1 : 0;
      ctx.S.gmAllFunctions = on;
      ctx.save();
      ctx.L.pushFunctionList(ctx.conn);
      const list = ctx.L.buildOpenFunctions();
      return ctx.ok(on ? `功能全开，已解锁 ${list.length} 项` : '已恢复按通关进度解锁');
    },
  },
  'm21_h': {
    name: '查询 GM 指令', args: '[=<关键字>]',
    run(ctx, p) {
      const kw = String(p[1] || '').trim();
      const rows = [];
      for (const [k, v] of Object.entries(module.exports)) rows.push({ k, n: v.name, isNew: true });
      for (const [k, n] of Object.entries(ctx.extraNames || {})) {
        if (!module.exports[k]) rows.push({ k, n, isNew: false });
      }
      const hit = kw ? rows.filter(r => r.k.includes(kw) || r.n.includes(kw)) : rows;
      const head = `共 ${rows.length} 条（★=新注册表）${kw ? `，匹配 "${kw}" ${hit.length} 条` : ''}：`;
      const body = hit.slice(0, 12).map(r => `${r.isNew ? '★' : ''}${r.k}(${r.n})`).join('、');
      const more = hit.length > 12 ? `…等 ${hit.length} 条，加关键字再查` : '';
      return ctx.ok(`${head}\n${body}${more}`.slice(0, 400));
    },
  },

  // ---------------- 任务 / 活跃度 ----------------
  'm21_mission': {
    name: '完成任务 N 次', args: '=<任务ID>=<次数>',
    run(ctx, p) {
      const id = parseInt(p[1]), n = Math.max(0, parseInt(p[2]) || 0);
      const m = MISSIONS.find(x => Number(x.id) === id);
      if (!m) return ctx.fail(`未知任务 ID ${p[1]}（见 CfgMission）`);
      ctx.S.missionState.counters[id] = Math.min(n, Number(m.num) || n);
      ctx.save();
      require('../handlers/activity').handlers.m_mission_list_tos(ctx.conn);
      return ctx.ok(`任务 ${id} 进度 ${ctx.S.missionState.counters[id]}/${m.num}`);
    },
  },
  'm21_activity': {
    name: '加任务活跃度', args: '=<数量>',
    run(ctx, p) {
      const n = parseInt(p[1]);
      if (!Number.isFinite(n)) return ctx.fail('用法 m21_activity=<数量>');
      const st = ctx.S.missionState;
      const before = Number(st.dailyActivity) || 0;
      st.dailyActivity = Math.max(0, Math.min(100, before + n));
      ctx.save();
      require('../handlers/activity').handlers.m_mission_list_tos(ctx.conn);
      return ctx.ok(`活跃度 ${before} → ${st.dailyActivity}（上限 100）`);
    },
  },

  // 信仰开关（活动 1041「信仰灵光掉落」）：控制誓灵详情「信仰」按钮显隐 + 关卡预览是否显示信仰灵光。
  // 官方口径是「通关剧情 6-4 后才可使用」，正常由 map_fight 在 6-4 BOSS 通关时自动解锁；
  // 本指令用于**不回档验证**（未通关也能测信仰面板）。见 调研-信仰.md §3.2。
  'm21_faith': {
    name: '信仰开关(1041)', args: '=1 开 / =0 恢复按进度',
    run(ctx, p) {
      const on = (parseInt(p[1]) || 0) ? 1 : 0;
      ctx.S.faithOpenOverride = on;
      ctx.save();
      const ACT = require('../handlers/activity');
      ACT.pushRoleActs(ctx.conn);
      const gate = ACT.faithGateOpen();
      return ctx.ok(on
        ? `信仰强制开启（1041 已下发，gate=${gate}）——誓灵详情「信仰」按钮应立刻出现`
        : `已恢复按进度（6-4 通关判定，当前 gate=${gate}）`);
    },
  },

  // 星图节点直接置级：正常路径要从 31→32→34/35→36→37→39/40 一路点上来才能摸到 42「幸运值UP」。
  // 本指令把 stars[id] 置成指定等级，用于验证宿主效果（如 42 = 训练大成功率）。
  // 只改状态不改消耗；前置不校验（GM 特权）。maxLv>0 的节点钳到 maxLv，无限节点（maxLv=0）不钳。
  'm21_star_lv': {
    name: '设置星图节点等级', args: '=<节点ID>[=<等级>]',
    run(ctx, p) {
      const id = parseInt(p[1]);
      const GD = require('./grow_data');
      const def = GD.STAR_BY_ID[id];
      if (!def) return ctx.fail(`无此星图节点：${id}（1~11 / 31~46，见 data/grow_data.js）`);
      let lv = Math.max(0, parseInt(p[2]) || 0);
      if (def.maxLv > 0) lv = Math.min(lv, def.maxLv);
      const g = require('../handlers/grow');
      g.starLv(1); // 触发 growState 懒初始化
      ctx.S.growState.stars[id] = lv;
      ctx.save();
      g.pushAstrolabeInfo(ctx.conn);
      return ctx.ok(`${id}(${def.name}) → Lv${lv}${def.maxLv > 0 ? `/${def.maxLv}` : '/∞'}`);
    },
  },

  // ---------------- 副本进度 ----------------
  'm21_copy_story': {
    name: '通关副本', args: '=<章>=<关>[=1]',
    run(ctx, p) {
      const ch = parseInt(p[1]), stg = parseInt(p[2]);
      const bid = 1000000 + ch * 10000 + stg * 100;
      const cfg = require('./map_configs').MAP_CONFIGS[bid];
      if (!cfg) return ctx.fail(`无此关卡：${ch}-${stg}（barrier ${bid}）`);
      const prog = ctx.L.progressOf(bid);
      if (!prog.cleared) prog.cleared = [];
      const had = prog.cleared.includes(cfg.bossPoint);
      if (!had) prog.cleared.push(cfg.bossPoint);
      ctx.save();
      ctx.L.pushFunctionList(ctx.conn);
      const sr = require('../handlers/story_reward');
      try {
        sr.pushRedPoint(ctx.conn); sr.pushDoubleInfo(ctx.conn);
        require('../handlers/servant').pushLineupInfo(ctx.conn);
      } catch (e) { /* 推送失败不影响进度已落 */ }
      return ctx.ok(`${had ? '本就已通关' : '已通关'} ${ch}-${stg}，当前章 ${sr.curChapter()}，`
        + `功能 [${ctx.L.buildOpenFunctions().join(',') || '无'}]`.slice(0, MAXTXT));
    },
  },
  'm21_reset_copy_times': {
    name: '重置挑战/曜日副本次数', args: '=1',
    run(ctx) {
      const dc = require('../handlers/daily_copy');
      const MF = require('../handlers/map_fight');
      dc.st();
      if (!ctx.S.dailyCopyState) ctx.S.dailyCopyState = { day: '', times: {}, cleared: [], forceOpen: 0 };
      ctx.S.dailyCopyState.times = {};
      // EX 挑战关每日次数（20004）一并清（三百一十四）：面板按钮叫"重置挑战次数"，只清曜日不清 EX
      // 就是用户报的"GM 刷新没用"。且推送必须走 exDailyLoginPush **合并全量**——dc.pushDailyTimes
      // 不含 20004，m_activity_daily_toc 客户端是整表替换（指南 C-8），会把 dailyDic 里的 20004
      // 条目抹掉：显示回满、进关仍被 262011 拒，"看着刷新了实际没用"。
      ctx.S.exState = null;
      ctx.save();
      MF.exDailyLoginPush(ctx.conn); // 20001~20003 + 20004 合并成一条全量包（整表替换语义）
      dc.pushDailyInfo(ctx.conn);
      return ctx.ok('曜日副本/EX 挑战次数已清零');
    },
  },
  'm21_dream_reset': {
    name: '重置银匙之门', args: '回满今日次数 / =1 进度全清（自测）',
    run(ctx, p) {
      const dm = require('../handlers/dream');
      if ((parseInt(p[1]) || 0) >= 1) {
        // 旧 if 链语义（=1）：进度/布阵/首通记录全清，从第 1 关重新走（自测全链路用）。
        ctx.S.dreamState = null;
        ctx.S.dreamFight = null;
        dm.st();
        ctx.save();
        dm.pushInfo(ctx.conn);
        return ctx.ok('进度已全清（第 1 关起，今日次数回满）');
      }
      // 面板按钮「重置银匙之门次数」是**裸发无参数**（CfgDebug gmCode="m21_reset_dream"，
      // codeParamVO={}），与旁边「重置挑战、曜日副本次数」同族语义——只把每日挑战次数回满，
      // 不动进度/首通记录（三百一十五：旧 if 链要 =1，裸发落到 UNIMPLEMENTED 弹「未实现」）。
      const R = require('../data/dream_rules');
      const s = dm.st();
      const before = Number(s.dailyLeft) || 0;
      s.dailyLeft = R.DAILY_TIMES_BASE;
      ctx.save();
      dm.pushInfo(ctx.conn);
      return ctx.ok(`今日挑战次数 ${before} → ${s.dailyLeft}（进度保持第 ${s.now} 关）`);
    },
  },

  // ---------------- 誓灵批量 ----------------
  'm21_lv2': {
    name: '1 级誓灵升 75 级', args: '=1',
    run(ctx) {
      const changes = [];
      let n = 0;
      for (const b of ctx.S.servants) {
        if (Number(b.level) >= 75) continue;
        b.level = Math.min(75, ctx.L.TRAIN.maxLevelOf(b));
        b.exp = 0;
        changes.push({ servant_id: b.id, key: ctx.L.CHANGE_ID_LEVEL, val: b.level },
          { servant_id: b.id, key: ctx.L.CHANGE_ID_EXP, val: 0 });
        n++;
      }
      if (!n) return ctx.ok('所有誓灵都已在 75 级以上');
      ctx.save();
      ctx.L.pushServantChanges(ctx.conn, changes);
      return ctx.ok(`${n} 只誓灵已升到 75 级`);
    },
  },
  'm21_sgod': {
    name: '誓灵满配', args: '=1',
    run(ctx) {
      const EV = require('./evolution_rules');
      const BK = require('./break_data');
      const ED = require('./energy_data');
      const FR = require('./feeling_rules');
      const now = Math.floor(Date.now() / 1000);
      if (!ctx.S.servants.length) return ctx.fail('没有誓灵');
      const chg = [];
      for (const b of ctx.S.servants) {
        b.overstep = BK.MAX_OVERSTEP;                       // 先突破，等级上限才到 130
        b.level = ctx.L.TRAIN.maxLevelOf(b);
        b.exp = 0;
        b.star = EV.MAX_STAR;
        b.energy_ceils = ED.ENERGY_PROPS.reduce((o, x) => (o[x] = ED.ENERGY_CEIL_MAX, o), {});
        b.feeling = Math.min(100, FR.maxFeelingOf(b));
        b.satisfaction = 0;
        if (!Array.isArray(b.feeling_record)) b.feeling_record = [];
        for (const ms of require('./feeling_data').RECORD_MILESTONES) {
          if (b.feeling >= ms && !b.feeling_record.some(r => Number(r.id) === ms)) b.feeling_record.push({ id: ms, val: now });
        }
        chg.push({ servant_id: b.id, key: ctx.L.CHANGE_ID_LEVEL, val: b.level },
          { servant_id: b.id, key: ctx.L.CHANGE_ID_OVERSTEP, val: b.overstep });
      }
      ctx.save();
      ctx.L.pushServantChanges(ctx.conn, chg);
      require('../handlers/servant').handlers.m_servants_brief_tos(ctx.conn);   // 星级/皮肤档位要重拉 brief 才刷新
      try { require('../handlers/feeling').pushFeelingChanges(ctx.conn, ctx.S.servants); } catch (e) { /* 忽略 */ }
      return ctx.ok(`${ctx.S.servants.length} 只：满级 ${ctx.S.servants[0].level} / `
        + `${EV.MAX_STAR}★ / ${BK.MAX_OVERSTEP} 突 / 能源 ${ED.ENERGY_CEIL_MAX} / 羁绊 100`);
    },
  },
  'm21_god': {
    name: '上帝（一条龙）', args: '=1',
    run(ctx) {
      const vit = require('../handlers/vit');
      ctx.S.roleAsset.gold = ctx.S.roleAsset.gold_given = 500000;
      ctx.S.roleAsset.silver = 5000000;
      ctx.S.roleAsset.level = ctx.L.ROLE_LEVEL.ROLE_MAX_LEVEL;
      ctx.S.roleAsset.exp = 0;
      vit.setVit(9999);
      ctx.save();
      ctx.L.pushAssetChange(ctx.conn);
      ctx.L.pushRoleLevelup(ctx.conn);
      vit.pushVit(ctx.conn);
      vit.pushLimit(ctx.conn);
      const r = module.exports['m21_sgod'].run(ctx, ['m21_sgod', '1']);
      return ctx.ok(`水晶/金币/体力/等级 Lv${ctx.S.roleAsset.level} 已给；誓灵满配：${r.msg.replace(/^✓ /, '')}`.slice(0, MAXTXT));
    },
  },
  'm21_add_all_servant': {
    name: '图鉴全誓灵', args: '[=数量上限]',
    run(ctx, p) {
      // 官方"仅敌人"伪誓灵（尤格/莎布/奈亚/克苏/辛西娅/杂鱼光）不入册：客户端无升星/图鉴/凭证配置，
      // 持有即坏誓灵小屋红点链（canEvolution pairs(nil)，见 调研-GM一键获取誓灵带出敌方伪誓灵.md）。
      // 图鉴本来也没有它们的条目——排除它们才是对齐本指令名字的语义。
      const pool = VALID_SERVANT_TYPE_LIST.filter(t => isObtainableServantType(t));
      const cap = Math.max(1, parseInt(p[1]) || pool.length);
      const SV = require('../handlers/servant');
      const have = new Set(ctx.S.servants.map(b => b.type));
      let added = 0;
      for (const t of pool) {
        if (added >= cap) break;
        if (have.has(t)) continue;
        const b = SV.makeServantBrief(t);
        if (b && SV.grantServantBrief(b)) added++;
      }
      if (!added) return ctx.ok('该有的都有了（图鉴类型已全持有）');
      ctx.save();
      const ids = SV.pushPendingServants(ctx.conn);
      const skipped = VALID_SERVANT_TYPE_LIST.length - pool.length;
      return ctx.ok(`新入档 ${added} 只（已增量宣告 ${ids.length} 只），共 ${ctx.S.servants.length} 只`
        + `\n（已排除 ${skipped} 只敌方伪誓灵：${UNOBTAINABLE_SERVANT_TYPES.join('/')}，官方无持有身份）`);
    },
  },
  'm21_clean_servant': {
    name: '分解空闲誓灵', args: '=1 统计 / =2 执行',    run(ctx, p) {
      // 只清"完全没培养过"的杂物：Lv1 + 初始星 + 0 突 + 未编队 + 非看板娘。
      // 两步确认：=1 只统计（默认），=2 才真删——单机存档不允许一条指令误删培养中的誓灵。
      const stage = parseInt(p[1]) || 1;
      const helper = Number((ctx.S.helperState && ctx.S.helperState.lastHelper) || 0);
      const EV = require('./evolution_rules');
      const junk = ctx.S.servants.filter(b => Number(b.level) <= 1
        && Number(b.overstep || 0) === 0
        && Number(b.star || EV.BASE_STAR) <= EV.BASE_STAR
        && !(b.team_ids && b.team_ids.length)
        && Number(b.id) !== helper);
      if (stage < 2) {
        return ctx.ok(`将分解 ${junk.length} 只未培养誓灵（Lv1/${EV.BASE_STAR}★/0突/未编队）\n`
          + `确认执行请再发 m21_clean_servant=2`.slice(0, MAXTXT));
      }
      if (!junk.length) return ctx.ok('没有可分解的未培养誓灵');
      const ids = new Set(junk.map(b => b.id));
      ctx.S.servants = ctx.S.servants.filter(b => !ids.has(b.id));
      ctx.save();
      require('../handlers/servant').handlers.m_servants_brief_tos(ctx.conn);
      return ctx.ok(`已分解 ${ids.size} 只，剩余 ${ctx.S.servants.length} 只`);
    },
  },
  'm21_chaos_all': {
    name: '设置所有誓灵暗噬', args: '=1 全节点拉满 / =0 清空（面板裸发=拉满）',
    run(ctx, p) {
      const CH = require('../data/chaos_data');
      const clear = p.length >= 2 && (parseInt(p[1]) || 0) === 0;
      if (!ctx.S.skinState) ctx.S.skinState = { owned: [], l2dOwned: [] };
      if (!Array.isArray(ctx.S.skinState.owned)) ctx.S.skinState.owned = [];
      if (!Array.isArray(ctx.S.skinState.l2dOwned)) ctx.S.skinState.l2dOwned = [];
      const changes = [], busy = [];
      let touched = 0, berserkN = 0;
      for (const b of ctx.S.servants) {
        // 派遣位/战斗位（status 4/8）与在场单位不动——战斗会话持单位快照，改了也不生效还添乱
        if (CH.isBusy(ctx.S, b)) { busy.push(b.id); continue; }
        if (clear) {
          b.chaos = [];
        } else {
          // 狂化节点 2001~2005 只对有狂化路线的誓灵生效（canUpgrade 同款门）：无路线誓灵
          // 拉满会把官方要「狂化解锁」才给的怒气技/形态一并放开，超出本指令意图。
          const berserk = CH.berserkOf(b);
          b.chaos = Object.entries(CH.NODES)
            .filter(([id]) => !(Number(id) >= 2001 && Number(id) <= 2005) || berserk)
            .map(([id, n]) => ({ id: Number(id), val: n.max }));
          if (berserk) {
            berserkN++;
            // 2004/2005 节点奖励=狂化皮肤（升级协议 chaos.js 同款收口），GM 直发登记所有权；
            // 面板下一次打开时经 m_servant_skin_tos / m_skin_live_state_tos 拉到新状态
            const skin = berserk.skin;
            if (skin && !ctx.S.skinState.owned.includes(skin)) ctx.S.skinState.owned.push(skin);
            if (skin && !ctx.S.skinState.l2dOwned.includes(skin)) ctx.S.skinState.l2dOwned.push(skin);
          }
        }
        CH.normalize(b); // dream_lv / rage_skill / status2 路线位同步（与升级协议同口）
        changes.push({ servant_id: b.id, key: 13, val: Number(b.status2) || 0 },
          { servant_id: b.id, key: 14, val: CH.fantasyGrowthOf(b) },
          { servant_id: b.id, key: 15, val: require('../data/ark_data').servantPower(b) });
        touched++;
      }
      ctx.save();
      if (changes.length) ctx.L.pushServantChanges(ctx.conn, changes);
      return ctx.ok(`${clear ? '已清空' : '已拉满'} ${touched} 只（狂化路线 ${berserkN} 只，皮肤重开面板可见）`
        + (busy.length ? `；忙碌跳过 ${busy.length} 只 [${busy.slice(0, 6).join(',')}${busy.length > 6 ? '…' : ''}]` : ''));
    },
  },

  // ---------------- 容量（二百三十：官方只能 50 水晶 +5 一点点扩，这里直接设）----------------
  // 实时刷新复用官方扩容回执——两条 toc 在客户端都是"到包即赋值"型
  // （ServantMgr.setBagSize / BagMgr.setBagSize，bc 实证无钳制，纯显示 x/y），
  // 落盘值在重登（m_servants_brief_toc.size）与开分页（m_goods_bag_info_toc.size）时同样生效。
  'm21_servant_size': {
    name: '设置誓灵小屋上限', args: '=<上限>',
    run(ctx, p) {
      const cur = ctx.S.servantBagSize || 100;
      if (p[1] === undefined) {
        return ctx.fail(`用法 m21_servant_size=<上限>（当前 ${cur}，持有 ${ctx.S.servants.length} 只）`);
      }
      const want = parseInt(p[1]);
      if (!Number.isFinite(want) || want < 1 || want > 99999) {
        return ctx.fail(`上限要在 1~99999 之间（收到 "${p[1]}"）`);
      }
      ctx.S.servantBagSize = want;
      ctx.save();
      ctx.conn.sendToc('m_servant_list_extend_toc', { size: want });
      const warn = ctx.S.servants.length > want
        ? `\n⚠️ 持有 ${ctx.S.servants.length} 只已超上限（服务端不拦获得，仅客户端显示"满"）`
        : '';
      return ctx.ok(`誓灵小屋 ${cur} → ${want}（持有 ${ctx.S.servants.length}）${warn}`);
    },
  },
  'm21_bag_size': {
    name: '设置背包上限', args: '=[分页=]<上限> 分页 1材料/2圣器/4核心/5活动/6礼物/7信仰/9元素（缺省 1）',
    run(ctx, p) {
      const PAGES = { 1: '材料', 2: '圣器', 4: '核心', 5: '活动', 6: '礼物', 7: '信仰', 9: '元素' };
      const baseOf = pg => (Number(ctx.S.bagSizes[pg]) > 0 ? Number(ctx.S.bagSizes[pg]) : 60);
      if (p[1] === undefined) {
        const cur = Object.entries(PAGES).map(([k, n]) => `${n}${baseOf(+k)}`).join(' / ');
        return ctx.fail(`用法 m21_bag_size=<上限> 或 m21_bag_size=<分页>=<上限>\n当前：${cur}`);
      }
      let page = 1, want;
      if (p[2] !== undefined) {
        page = parseInt(p[1]); want = parseInt(p[2]);
      } else {
        page = 1; want = parseInt(p[1]);
      }
      if (!Number.isFinite(page) || !PAGES[page]) {
        return ctx.fail(`分页只能是 ${Object.keys(PAGES).join('/')}（收到 "${p[1]}"）`);
      }
      if (!Number.isFinite(want) || want < 1 || want > 99999) {
        return ctx.fail(`上限要在 1~99999 之间（收到 "${p[2] !== undefined ? p[2] : p[1]}"）`);
      }
      // 星图加成（40 号材料 +5/级、41 号圣器/核心 +5/级）是 bagSizeOf 的活加成，不在存档 base 里。
      // GM 写 base、推送/回执报"有效值"，不把加成吸进存档（官方扩容路径会吸收，历史行为不动）。
      const bonus = ctx.L.bagSizeOf(page) - baseOf(page);
      ctx.S.bagSizes[page] = want;
      const eff = want + bonus;
      ctx.save();
      ctx.conn.sendToc('m_extend_bag_toc', { bag_type: page, content: eff });
      return ctx.ok(`${PAGES[page]}背包 ${baseOf(page)} → ${want}（有效 ${eff}${bonus ? `，含星图 +${bonus}` : ''}）`);
    },
  },

  // ---------------- 冷门开关（P3 批 3 的一部分；只做"改一个状态字段 + 用现成推送"的）----------------
  'm21_add_satisfaction': {
    name: '增加满足度', args: '=<数量>[=<誓灵ID>]',
    run(ctx, p) {
      const n = parseInt(p[1]);
      const sid = parseInt(p[2]) || 0;
      if (!Number.isFinite(n)) return ctx.fail('用法 m21_add_satisfaction=<数量>[=<誓灵ID>]');
      const targets = sid ? ctx.S.servants.filter(b => Number(b.id) === sid) : ctx.S.servants;
      if (!targets.length) return ctx.fail(`未持有该誓灵（id ${sid}）`);
      targets.forEach(b => { b.satisfaction = Math.max(0, Math.min(100, (Number(b.satisfaction) || 0) + n)); });
      ctx.save();
      require('../handlers/feeling').pushFeelingChanges(ctx.conn, targets);
      return ctx.ok(`满足度 +${n}：${targets.length} 只（当前 ${targets[0].satisfaction}/100）`);
    },
  },
  'm21_family_reset': {
    name: '结社每日重置', args: '=1',
    run(ctx) {
      const fam = require('../handlers/family');
      if (!fam.hasFamily()) return ctx.fail('还没有结社，先建社或用游戏内流程');
      fam.checkFamilyReset(ctx.conn);   // 与登录时同一条例程：签到/宝箱来袭次数/贡献结算按日翻转
      fam.pushFamilyInfo(ctx.conn);
      return ctx.ok('结社每日状态已按今天重算（签到/宝箱次数/昨日贡献）');
    },
  },
  'm21_box': {
    name: '结社宝箱怪次数', args: '=<剩余次数>',
    run(ctx, p) {
      const fam = require('../handlers/family');
      if (!fam.hasFamily()) return ctx.fail('还没有结社');
      const F = require('./family_data');
      const want = Math.max(0, parseInt(p[1]) || 0);
      fam.checkFamilyReset(ctx.conn);          // 先按日翻转，别把昨天的用量当今天
      const st = ctx.S.familyState;
      if (!st) return ctx.fail('结社状态未初始化');
      st.bossUseTimes = Math.max(0, F.BOSS_DAILY_TIMES - want);
      ctx.save();
      fam.pushFamilyInfo(ctx.conn);
      return ctx.ok(`今日剩余 ${Math.max(0, F.BOSS_DAILY_TIMES - st.bossUseTimes)}/${F.BOSS_DAILY_TIMES} 次`);
    },
  },

  // ---------------- 无限领域（塔）----------------
  'm21_pass_tower': {
    name: '无限领域通关到 N 关', args: '=<关数>',
    run(ctx, p) {
      const t = require('../handlers/tower');
      const n = Math.max(1, parseInt(p[1]) || 1);
      const s = t.st();
      s.barrier = n;                                   // 当前关
      s.weekMax = Math.max(Number(s.weekMax) || 0, n);  // 本周最高
      s.historyMax = Math.max(Number(s.historyMax) || 0, n);
      s.team = null;                                   // 编队作废，进塔重新选
      ctx.save();
      t.pushInfo(ctx.conn);
      return ctx.ok(`已跳到第 ${n} 关（本周最高 ${s.weekMax}，编队已清）`);
    },
  },
  'm21_tower_add_recover': {
    name: '无限领域加恢复次数', args: '=<次数>',
    run(ctx, p) {
      const t = require('../handlers/tower');
      const n = Math.max(1, parseInt(p[1]) || 1);
      const s = t.st();
      // 注意：字段名叫 recoverUsed，含义其实是"**剩余**恢复次数"（handleRecover 里 -=1 才是消耗）
      s.recoverUsed = (Number(s.recoverUsed) || 0) + n;
      ctx.save();
      t.pushInfo(ctx.conn);
      return ctx.ok(`恢复次数 +${n} → 余 ${s.recoverUsed}`);
    },
  },
  'm21_reset_tower': {
    name: '刷新无限领域天赋', args: '=1',
    run(ctx, p) {
      const t = require('../handlers/tower');
      const n = parseInt(p[1]) || 0;
      const s = t.st();
      if (!n) return ctx.fail('本服只支持 =1（重摇本周词条）');
      s.buffs = t.rollBuffs();
      ctx.save();
      t.pushInfo(ctx.conn);
      return ctx.ok(`本周词条已重摇：${(s.buffs || []).map(b => b.name || b.id).join(' / ') || '(空)'}`.slice(0, MAXTXT));
    },
  },

  // ---------------- 唤灵殿堂 / 协会派遣 / 时光银行（三百一十五：功能早已贯通，补 GM 接线） ----------------
  'm21_dare_copy': {
    name: '开启全部唤灵殿堂', args: '=1（面板硬编码 1/3 都收）',
    run(ctx, p) {
      if ((parseInt(p[1]) || 0) < 1) return ctx.fail('用法 m21_dare_copy=1');
      const D = require('../data/dare_data');
      const dare = require('../handlers/dare');
      const s = dare.st();
      const all = D.CHAPTERS.flatMap(c => c.bossArr);
      // 章节解锁 = 前一章 BOSS 全战胜（chapterUnlocked），全部标记即全章开放；
      // claimedFirst 不动 ⇒ 首通奖励仍可领（自测领奖链），每周奖励档（claimedTiers）也不动。
      s.defeated = all.slice();
      ctx.save();
      dare.handlers.m_dare_info_tos(ctx.conn);
      return ctx.ok(`已战胜 ${s.defeated.length}/${all.length}，全章节开放（首通未领的仍可领）`);
    },
  },
  'm21_dare_pass': {
    name: '通关唤灵殿堂', args: '=<章节1-8>=<难度>',
    run(ctx, p) {
      const ch = parseInt(p[1]), diff = parseInt(p[2]);
      const D = require('../data/dare_data');
      const dare = require('../handlers/dare');
      const chapter = D.CHAPTERS.find(c => c.chapter === ch);
      if (!chapter || ch < 1) return ctx.fail(`章节须为 1~8（收到 ${ch}）；0=活动挑战请用 m21_dare_copy=1 全开`);
      // bossID 规则：{章节}*1000+难度（chapter1=[1003,1002,1001] ⇒ 难度 1~3），dare_data 实表核对
      const bid = ch * 1000 + diff;
      if (!chapter.bossArr.includes(bid)) {
        return ctx.fail(`章节 ${ch} 没有难度 ${diff}（可用 1~${chapter.bossArr.length}）`);
      }
      const s = dare.st();
      if (!s.defeated.includes(bid)) s.defeated.push(bid);
      ctx.save();
      dare.handlers.m_dare_info_tos(ctx.conn);
      const b = D.BOSS_LIST[bid];
      return ctx.ok(`章节${ch}难度${diff}「${b ? b.title : bid}」已标记战胜（首通奖励可领）`);
    },
  },
  'm21_dare_season': {
    name: '唤灵殿堂刷新下一期', args: '（面板裸发无参数）',
    run(ctx) {
      const dare = require('../handlers/dare');
      const s = dare.st();
      s.defeated = [];      // 下一期：BOSS 重新可战
      s.claimedTiers = {};  // 每周奖励档重置
      s.gotItems = [];      // 每周已领重置
      ctx.save();
      dare.handlers.m_dare_info_tos(ctx.conn);
      return ctx.ok('已进入下一期：战胜记录/每周奖励重置（首通领取记录保留）');
    },
  },
  'm21_re_dare': {
    name: '唤灵殿堂刷新全部副本', args: '=1（面板硬编码 1）',
    run(ctx, p) {
      if ((parseInt(p[1]) || 0) < 1) return ctx.fail('用法 m21_re_dare=1');
      const dare = require('../handlers/dare');
      const s = dare.st();
      const n = Object.keys(s.spirit || {}).length;
      // 本服殿堂无每周轮换副本，"刷新副本"最贴的口 = 元气清账回满（spiritOf 空记录=100），
      // 全部副本立即可再挑战；战胜/首通状态不动（那是 dare_season 的事）。
      s.spirit = {};
      ctx.save();
      dare.handlers.m_servant_pl_info_tos(ctx.conn);
      return ctx.ok(`全员元气回满（${n} 只的在账记录清零重计），全部副本可再次挑战`);
    },
  },
  'm21_crusade': {
    name: '派遣完成', args: '=1 派遣中的队伍立即完成（面板硬编码 3 也收）',
    run(ctx, p) {
      if ((parseInt(p[1]) || 0) < 1) return ctx.fail('用法 m21_crusade=1');
      const dorm = require('../handlers/dorm');
      const now = Math.floor(Date.now() / 1000);
      const troops = Array.isArray(ctx.S.dormState && ctx.S.dormState.troops) ? ctx.S.dormState.troops : [];
      if (!troops.length) return ctx.ok('当前没有进行中的派遣');
      let n = 0;
      for (const t of troops) if (Number(t.end_time) > now) { t.end_time = now - 1; n++; }
      ctx.save();
      dorm.sendCrusadeDetail(ctx.conn); // 客户端按 detail 的 end_time 显示"已完成"，领奖走正常协议
      return ctx.ok(`${n}/${troops.length} 队已立即完成，到派遣面板领奖（走正常领奖结算，奖励不双发）`);
    },
  },
  'm21_reset_crusade': {
    name: '派遣重置', args: '=1 召回全部队伍（不发奖励）',
    run(ctx, p) {
      if ((parseInt(p[1]) || 0) < 1) return ctx.fail('用法 m21_reset_crusade=1');
      const dorm = require('../handlers/dorm');
      const troops = Array.isArray(ctx.S.dormState && ctx.S.dormState.troops) ? ctx.S.dormState.troops : [];
      if (!troops.length) return ctx.ok('当前没有派遣队');
      const changes = [];
      for (const t of troops) for (const sid of (t.servant_ids || [])) {
        const b = ctx.S.servants.find(x => Number(x.id) === Number(sid));
        if (!b) continue;
        const st = (Number(b.status) || 0) & ~4; // 位2=派遣位（STATUS_DISPATCH），与召回协议同口
        if (st !== (Number(b.status) || 0)) { b.status = st; changes.push({ servant_id: b.id, key: 3, val: st }); }
      }
      ctx.S.dormState.troops = [];
      ctx.save();
      dorm.sendCrusadeDetail(ctx.conn);
      if (changes.length) ctx.L.pushServantChanges(ctx.conn, changes);
      return ctx.ok(`已召回 ${troops.length} 队（奖励未发放），队列已清空`);
    },
  },
  'm21_time_bank': {
    name: '时光银行加经验', args: '=<经验数量>',
    run(ctx, p) {
      const dorm = require('../handlers/dorm');
      const n = Math.floor(Number(p[1]));
      if (!Number.isFinite(n) || n <= 0) return ctx.fail('用法 m21_time_bank=<经验数量>');
      if (!ctx.S.dormState) return ctx.fail('协会状态未初始化');
      const before = Math.floor(Number(ctx.S.dormState.bankExp) || 0);
      const cap = dorm.bankCap();
      const after = Math.min(cap, before + n);
      ctx.S.dormState.bankExp = after;
      ctx.save();
      dorm.handlers.m_building_time_bank_detail_tos(ctx.conn);
      const clipped = n - (after - before);
      return ctx.ok(`银行经验 ${before} → ${after}（上限 ${cap}，银行 Lv${dorm.bankLevel()}）`
        + (clipped > 0 ? `，${clipped} 溢出未计` : ''));
    },
  },
  'm21_furnitures': {
    name: '获得家具', args: '=0 全家具各+1（受上限钳制，可多次点） / =<家具ID>[=<数量>]',
    run(ctx, p) {
      const dorm = require('../handlers/dorm');
      const FUR = require('./dorm_furniture_data').FURNITURE;
      const arg1 = p[1] !== undefined ? parseInt(p[1]) : 0;
      if (p.length < 2 || arg1 === 0) {
        // 面板按钮「指令 → 社交 → 获得家具」（CfgDebug gmCode="m21_furnitures=0"）走本分支：
        // 全部 295 种安全可持有家具（已排除 4 件系统建筑 + 4 件施工牌 + 无资源 200020；
        // 互动家具 200021/200022/200024 与圣诞壁炉 30025 保留作摆设），每次各 +1（或手打 =0=<N>），
        // 受各自 maxNum 上限钳制，整批 1 次落盘 + 1 条合并 m_furnitures_update_toc。
        const per = p.length >= 3 ? Math.max(1, Math.min(99, parseInt(p[2]) || 1)) : 1;
        const entries = dorm.ALL_GRANTABLE_FURNITURE_IDS.map(id => [id, per]);
        const r = dorm.grantFurnitureBatch(ctx.conn, entries, { capByMaxNum: true });
        if (r.addedItems === 0) {
          return ctx.ok(`全部 ${r.totalKinds} 种可持有家具均已达拥有上限（未再增加）`);
        }
        return ctx.ok(`新增 ${r.addedItems} 件（覆盖 ${r.addedKinds} 种`
          + (r.cappedKinds ? `，${r.cappedKinds} 种已达上限` : '')
          + `；安全全表 ${r.totalKinds} 种）`);
      }
      if (!Number.isFinite(arg1) || arg1 < 0) {
        return ctx.fail('用法 m21_furnitures=0（全家具各+1）或 m21_furnitures=<家具ID>[=<数量>]');
      }
      const num = p.length >= 3 ? parseInt(p[2]) : 1;
      if (!Number.isFinite(num) || num <= 0 || num > 999) {
        return ctx.fail(`数量须为 1~999 的整数（收到 "${p[2]}"）`);
      }
      const meta = FUR[arg1];
      if (!meta) return ctx.fail(`未知家具 ID ${arg1}（CfgHouseFurniture 无此配置）`);
      if (!dorm.isGrantableFurniture(arg1)) {
        return ctx.fail(`家具 ${arg1}（${meta.name}）不可发入仓库（系统建筑/施工占位/无资源件）`);
      }
      dorm.grantFurniture(ctx.conn, arg1, num);
      return ctx.ok(`${arg1}（${meta.name}）+${num} → 仓库 ${ctx.S.dormState.warehouse[arg1]}`);
    },
  },

  // ---------------- 言灵录 / 双倍 / 签到 / 灵契 ----------------
  'm21_cv': {
    name: '解锁语音', args: '=<誓灵类型ID>',
    run(ctx, p) {
      // 本服口径（handbook.js 头注）：图鉴激活即全语音解锁（cv_list 全量下发），
      // 没有逐条解锁状态可写——如实回执，别让面板弹「未实现」。
      const t = parseInt(p[1]) || 0;
      return ctx.ok(`语音默认全解锁（图鉴激活即全开，无逐条状态）${t ? `：类型 ${t} 无需操作` : ''}`);
    },
  },
  'm21_moments': {
    name: '言灵录解锁', args: '[=<誓灵类型ID>]',
    run(ctx, p) {
      const MD = require('./moment_data');
      const moment = require('../handlers/moment');
      const ty = parseInt(p[1]) || 0;
      const s = moment.st();
      const now = Math.floor(Date.now() / 1000);
      let n = 0;
      for (const m of MD.MOMENTS) {
        if (ty && Number(m.servant_type) !== ty) continue;
        if (!s.unlocked[m.m_id]) { s.unlocked[m.m_id] = now; n++; }
      }
      if (!n) return ctx.ok(ty ? `类型 ${ty} 的言灵录本就全解锁` : '言灵录本就全解锁');
      ctx.save();
      moment.pushNum(ctx.conn);
      return ctx.ok(`解锁 ${n} 条${ty ? `（类型 ${ty}）` : '（全部）'}，共 ${Object.keys(s.unlocked).length} 条`);
    },
  },
  'm21_copy_story_double_buff_reset_all': {
    name: '重置主线双倍次数', args: '=1',
    run(ctx) {
      const sr = require('../handlers/story_reward');
      sr.st();                                  // 建默认结构（doubleTimes/buyUsed/switchOn）
      const s = ctx.S.storyState;
      s.doubleTimes = 0;
      s.buyUsed = 0;
      s.switchOn = 0;
      ctx.save();
      sr.pushDoubleInfo(ctx.conn);
      return ctx.ok('双倍持有/今日已购/开关已清零');
    },
  },
  'm21_accumulative_sign': {
    name: '签到 N 天', args: '[=<任务ID>]=<天数>',
    run(ctx, p) {
      const act = require('../handlers/activity');
      const days = parseInt(p[p.length - 1]);
      if (!Number.isFinite(days)) return ctx.fail('用法 m21_accumulative_sign=[任务ID]=<天数>');
      // 先让服务端跑一次周期初始化（跨月会把 days 归零），再写天数，最后推一次
      act.handlers.m_role_sign_info_tos(ctx.conn, { reward_list_id: 0 });
      const s = ctx.S.signState;
      if (!s) return ctx.fail('签到状态未初始化');
      s.days = Math.max(0, days);
      ctx.save();
      act.handlers.m_role_sign_info_tos(ctx.conn, { reward_list_id: 0 });
      return ctx.ok(`本月签到天数置为 ${s.days}`);
    },
  },
  'm21_pledge': {
    name: '缔结灵契', args: '=<誓灵类型ID | 实例ID>',
    run(ctx, p) {
      const key = parseInt(p[1]) || 0;
      if (!key) return ctx.fail('用法 m21_pledge=<誓灵类型ID 或 实例ID>');
      let targets = ctx.S.servants.filter(b => Number(b.id) === key);
      if (!targets.length) targets = ctx.S.servants.filter(b => Number(b.type) === key);
      if (!targets.length) return ctx.fail(`找不到誓灵（id/type ${key}）`);
      const now = Math.floor(Date.now() / 1000);
      targets.forEach(b => { b.pledge = 1; b.pledge_time = now; });
      ctx.save();
      // key=12 是"已婚"的唯一权威（客户端 isMarry 只看 pledge_time>0）；key=10 同步保持字段一致
      ctx.L.pushServantChanges(ctx.conn, targets.flatMap(b => ([
        { servant_id: b.id, key: 10, val: 1 },
        { servant_id: b.id, key: 12, val: now },
      ])));
      // 灵契皮肤联动：有灵契皮（actItemID==1）的 type 补推皮肤面板数据（客户端缓存 dataIsOK 不重拉）
      const skinPushed = targets.filter(b => require('../handlers/servant').pushMarrySkinRefresh(ctx.conn, b)).length;
      return ctx.ok(`已缔结 ${targets.length} 只（type ${targets[0].type}）${skinPushed ? `，婚皮解锁推送 ${skinPushed} 条` : ''}`);
    },
  },
  'm21_pledge_all': {
    name: '全体缔结灵契', args: '=1',
    run(ctx) {
      if (!ctx.S.servants.length) return ctx.fail('没有誓灵');
      const now = Math.floor(Date.now() / 1000);
      const todo = ctx.S.servants.filter(b => !(Number(b.pledge_time) > 0));
      todo.forEach(b => { b.pledge = 1; b.pledge_time = now; });
      if (!todo.length) return ctx.ok('所有誓灵都已缔结');
      ctx.save();
      ctx.L.pushServantChanges(ctx.conn, todo.flatMap(b => ([
        { servant_id: b.id, key: 10, val: 1 },
        { servant_id: b.id, key: 12, val: now },
      ])));
      // 灵契皮肤联动：只对有灵契皮（actItemID==1）的 type 推送，上限 15 type 不会刷屏
      const skinPushed = todo.filter(b => require('../handlers/servant').pushMarrySkinRefresh(ctx.conn, b)).length;
      return ctx.ok(`新缔结 ${todo.length} 只（共 ${ctx.S.servants.length}）${skinPushed ? `，婚皮解锁推送 ${skinPushed} 条` : ''}`);
    },
  },

  // ---------------- 作战策略 ----------------
  'm21_ai_mode': {
    name: '切换作战策略', args: '=<4|6>[=<0|1|2>]（4=自动：0最优/1单体至上/2群体优先；6=自行）',
    run(ctx, p) {
      const SC = require('../handlers/skill_choice');
      const id = parseInt(p[1]) || 0;
      const val = parseInt(p[2]) || 0;
      if ((id !== 4 && id !== 6) || (id === 4 && ![0, 1, 2].includes(val))) {
        return ctx.fail('用法 m21_ai_mode=<4|6>[=<0|1|2>]');
      }
      SC.handlers.m_servant_ai_type_tos(ctx.conn, { ai_id: id, ai_value: val });
      const a = ctx.S.aiState;
      return ctx.ok(`作战策略 → ${a.modeId === 6 ? '自行（按誓灵技能循环）' : `自动·${['最优策略', '单体至上', '群体优先'][a.modeValue]}`}`);
    },
  },
  'm21_ai_show': {
    name: '查看作战策略', args: '=1',
    run(ctx) {
      const a = ctx.S.aiState || {};
      const slots = Object.values(a.tactics || {})
        .map(t => `槽${t.id}「${t.name}」(${(t.servants || []).length}誓灵)`).join('、') || '（空）';
      const applied = Object.entries(a.applied || {}).map(([k, v]) => `队${k}→槽${v}`).join('、') || '（无）';
      return ctx.ok(`模式 ${a.modeId}/${a.modeValue}；方案 ${slots}；应用 ${applied}；`
        + `循环 ${ctx.S.servants.filter(b => Array.isArray(b.ai_skills) && b.ai_skills.some(x => x > 0)).length} 只誓灵已编排`);
    },
  },

  // ---------------- 信件 ----------------
  'm21_test_letter': {
    name: '发测试信件', args: '=[标题]=[正文]（缺省发内置测试信：称号盒+约定之契附件）',
    run(ctx, p) {
      const L = require('../handlers/letter');
      const title = p[1] || '测试信件';
      const text = p[2] || '这是一封测试信件，用于验证邮件面板全链路（分页/阅读/领取/删除/锁定）。';
      const rec = L.insertLetter({
        title: [title], text: [text],
        goods: [{ id: 25001015, val: 1 }, { id: 31000004, val: 3 }],
      });
      if (!rec) return ctx.fail('信箱已满（500）');
      L.pushLight(ctx.conn);
      return ctx.ok(`测试信件 #${rec.id} 已投递并推送红点（附件：称号盒「正在摸鱼的」×1、约定之契×3）`);
    },
  },
};
