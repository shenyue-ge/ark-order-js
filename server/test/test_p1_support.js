// P1 辅助技能实现验证（纯服务端单元测试）
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FC = require(path.join(ROOT, 'data/fight_core.js'));
const SE = require(path.join(ROOT, 'data/skill_effect_data.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
function mk(o) {
  const u = Object.assign({
    id: 1, side: 0, pos: [-1, 0], hp: 1000, maxHp: 1000,
    attrs: { hp: 1000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 },
    statLevels: {}, buffs: {}, skills: [], type: 10001, nature: 1, level: 50, talent: 0,
    dmgMul: 0, selfMit: 0, teamMit: 0, dodge: 0, critLv: 0, critMul: 0, critMit: 0, immuneCrit: false,
    natMul: {}, weekMul: 0, relicId: 0,
  }, o);
  FC.initUnitBattleState(u);
  return u;
}
const cfg = id => FC.skillCfg(id);
const st = (r = 1) => ({ round: r, weather: null, selMap: {} });

console.log('== 10270 虚伪创生 ==');
{
  const a = mk(); FC.applySkillEffects(a, cfg(10270), [a], [a], 0, st());
  ok('魔攻/物防/魔防各 +1', a.statLevels[102] === 1 && a.statLevels[103] === 1 && a.statLevels[104] === 1, a.statLevels);
}

console.log('== 10305 善根萌长 ==');
{
  const a = mk(), t = mk({ id: 2 });
  t.statLevels = { 101: -2, 102: -1, 105: -3 };
  FC.applySkillEffects(a, cfg(10305), [t], [a, t], 0, st());
  ok('负面等级转为正向', t.statLevels[101] === 2 && t.statLevels[102] === 1 && t.statLevels[105] === 3, t.statLevels);
}

console.log('== 10289 光之妖刃 ==');
{
  const a = mk({ statLevels: { 101: 2, 102: 1 } }), t = mk({ id: 2, statLevels: { 101: 0, 102: -1, 103: -2 } });
  FC.applySkillEffects(a, cfg(10289), [t], [a, t], 0, st());
  ok('目标能力等级被施放者覆盖', t.statLevels[101] === 2 && t.statLevels[102] === 1 && t.statLevels[103] === 0, t.statLevels);
}

console.log('== 10320 注意集中 ==');
{
  const a = mk(), t = mk({ id: 2 }), foe = mk({ id: 11, side: 1 });
  FC.applySkillEffects(a, cfg(10320), [t], [a, t, foe], 0, st());
  ok('3 回合免降级/免异常', t.statDownImmuneRounds === 3 && t.noAbnormalRounds === 3, { d: t.statDownImmuneRounds, a: t.noAbnormalRounds });
  FC.gainStat(t, 101, -2, { effects: [], srcId: 1, srcType: 1 });
  ok('降级被免疫', (t.statLevels[101] || 0) === 0, t.statLevels);
  FC.applySkillEffects(foe, cfg(10096), [t], [a, t, foe], 0, st());
  ok('异常被免疫', !(t.buffs && t.buffs[50005]), t.buffs);
}

console.log('== 10321 后见之明 ==');
{
  const a = mk(), t = mk({ id: 2 });
  t.hitThisRound = true;
  FC.applySkillEffects(a, cfg(10321), [t], [a, t], 0, st());
  ok('受击后物攻/魔攻/速度 +2', t.statLevels[101] === 2 && t.statLevels[102] === 2 && t.statLevels[105] === 2, t.statLevels);
  const u = mk({ id: 3, skills: [{ id: 10321, pp: 10 }] });
  FC.applySkillPriorities([u], st(), { [u.id]: { skillId: 10321 } });
  ok('优先度 -1', u.chosenSkillPrio === -1, u.chosenSkillPrio);
}

console.log('== 10285 ORa！ ==');
{
  const a = mk(), foe = mk({ id: 11, side: 1 });
  FC.applySkillEffects(a, cfg(10285), [a], [a, foe], 0, st());
  ok('敌方被吸引到自身', foe.tauntedBy === a.id && foe.tauntRounds === 1, { by: foe.tauntedBy, r: foe.tauntRounds });
  const d = (a.statLevels[103] || 0) + (a.statLevels[104] || 0);
  ok('随机一项防御 +1', d === 1, a.statLevels);
}

console.log('== 10253 王座的守护 ==');
{
  const caster = mk(), target = mk({ id: 2 });
  const foe = mk({ id: 11, side: 1 });
  FC.applySkillEffects(caster, cfg(10253), [target], [caster, target, foe], 0, st());
  ok('获得 25% 减伤与受击加攻标记（加攻窗口 2 回合）', target.inDmgDownRounds === 1 && target.inDmgDownPct === 25 && target.kingsGuardRounds === 2, target);
  const oldRnd = Math.random;
  function dmg(withGuard) {
    const atk = mk({ id: 5, side: 0 }), t = mk({ id: 15, side: 1, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
    if (withGuard) { t.inDmgDownRounds = 1; t.inDmgDownPct = 25; }
    Math.random = () => 0.5;
    FC.settleSkill(atk, cfg(10016), [t], [atk, t], null, 0, st());
    Math.random = oldRnd;
    return 5000 - Math.round(t.hp);
  }
  const d0 = dmg(false), d1 = dmg(true);
  ok('受到伤害降低约 25%', Math.abs(d1 / d0 - 0.75) < 0.02, { d0, d1 });
  // 每次受击较高攻 +1
  const caster2 = mk(), t2 = mk({ id: 6, hp: 5000, maxHp: 5000 }), foe2 = mk({ id: 12, side: 1 });
  t2.kingsGuardRounds = 1;
  const atkLv0 = (t2.statLevels[101] || 0) + (t2.statLevels[102] || 0);
  FC.settleSkill(foe2, cfg(10016), [t2], [caster2, t2, foe2], null, 0, st());
  ok('受击记录待回合末加攻', t2.kingsGuardHits === 1, t2.kingsGuardHits);
  FC.settleRoundEndTicks([caster2, t2, foe2], st(1));
  const atkLv1 = (t2.statLevels[101] || 0) + (t2.statLevels[102] || 0);
  ok('回合末较高攻 +1', atkLv1 === atkLv0 + 1, { atkLv0, atkLv1 });
  // 较高攻已 +6 时补另一项
  const t3 = mk({ id: 7, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 90, phy_def: 50, mag_def: 50, speed: 100 } });
  t3.kingsGuardRounds = 1;
  t3.statLevels[101] = 6;
  FC.settleSkill(mk({ id: 13, side: 1 }), cfg(10016), [t3], [t3, mk({ id: 14, side: 1 })], null, 0, st());
  FC.settleRoundEndTicks([t3], st(1));
  ok('较高攻顶满时补另一项攻击', (t3.statLevels[102] || 0) === 1, t3.statLevels);
}

console.log('== 10263 血坏 ==');
{
  const a = mk({ id: 1, hp: 1000, maxHp: 1000 });
  FC.applySkillEffects(a, cfg(10263), [a], [a], 0, st());
  ok('物攻等级提升至最大', a.statLevels[101] === 6, a.statLevels);
  ok('血坏 3 回合', a.bloodRuinRounds === 3);
  const hps = [Math.round(a.hp)];
  for (let r = 1; r <= 3; r++) { FC.settleRoundEndTicks([a], st(r)); hps.push(Math.round(a.hp)); }
  ok('回合末损失 10%/20%/30%（1000→900→700→400）', JSON.stringify(hps) === JSON.stringify([1000, 900, 700, 400]), hps);
}

console.log('== 10323 永恒解脱 ==');
{
  const a = mk({ id: 1, type: 1434035 }), foe = mk({ id: 11, side: 1 });
  FC.applySkillEffects(a, cfg(10323), [a], [a, foe], 0, st());
  ok('4 回合伤害 ×4', a.eternalReleaseRounds === 4 && a.eternalReleaseDmgMul === 4);
  ok('记录解脱到期回合（施放回合+4）', a.eternalReleaseAtRound === 5, a.eternalReleaseAtRound);
  const oldRnd = Math.random;
  function dmg(withBuff) {
    const atk = mk({ id: 5 }), t = mk({ id: 15, side: 1, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
    if (withBuff) atk.eternalReleaseRounds = 4;
    Math.random = () => 0.5;
    FC.settleSkill(atk, cfg(10016), [t], [atk, t], null, 0, st());
    Math.random = oldRnd;
    return 5000 - Math.round(t.hp);
  }
  const d0 = dmg(false), d1 = dmg(true);
  ok('伤害约 ×4', Math.abs(d1 / d0 - 4) < 0.05, { d0, d1 });
  for (let r = 1; r <= 4; r++) FC.settleRoundEndTicks([a], st(r));
  ok('4 回合后进入解脱状态', a.eternalReleased === true && a.eternalReleaseRounds === 0, { released: a.eternalReleased, rounds: a.eternalReleaseRounds });
  // 解脱状态被魔攻技能攻击必定被击倒
  const killer = mk({ id: 21, side: 1 });
  const res = FC.settleSkill(killer, cfg(10018), [a], [a, killer], null, 0, st(5));
  const e = res.find(x => x.target === a.id);
  ok('解脱状态被魔攻攻击直接击倒', !!e && Number(e.final_hp) <= 0, e);
  // 解脱后再次施放 10323 不应解除锁定
  FC.applySkillEffects(a, cfg(10323), [a], [a, foe], 0, st(5));
  ok('解脱后重复施放 10323 不会解除锁定', a.eternalReleased === true, a.eternalReleased);
  // 解脱状态只能使用辅助技能
  const sup = mk({ id: 3, skills: [{ id: 10245, pp: 10 }, { id: 10016, pp: 10 }] });
  sup.eternalReleased = true;
  const usable = FC.aiUsableList(sup);
  ok('解脱状态只能使用辅助技', usable.length === 1 && usable[0].id === 10245, usable.map(s => s.id));
}

console.log('== 10399 瑶草 ==');
{
  const a = mk({ id: 1 }), t = mk({ id: 2, hp: 5000, maxHp: 5000 }), foe = mk({ id: 11, side: 1, hp: 5000, maxHp: 5000 });
  FC.applySkillEffects(a, cfg(10399), [t], [a, t, foe], 0, st());
  ok('目标获得 1 回合反伤', t.reflectDirectRounds === 1);
  const before = foe.hp;
  const res = FC.settleSkill(foe, cfg(10016), [t], [a, t, foe], null, 0, st());
  ok('攻击者受到反伤', foe.hp < before, { before, after: foe.hp });
  ok('反伤写入 reflectEvents（map_fight 独立行动显示数字）', !!res.reflectEvents && res.reflectEvents.length === 1 && res.reflectEvents[0].amount > 0, res.reflectEvents);
}

console.log('== 10414 无上宽恕 ==');
{
  const a = mk({ id: 1, statLevels: { 101: 3, 103: -1, 105: 2 } });
  FC.applySkillEffects(a, cfg(10414), [a], [a], 0, st());
  const cleared = 3 + 1 + 2;
  ok('自身所有能力等级清零', [101, 102, 103, 104, 105].every(p => (a.statLevels[p] || 0) === 0), a.statLevels);
  ok('5 回合增伤/暴击 = n×10%', a.forgiveDmgRounds === 5 && Math.abs(a.forgiveDmgPct - cleared * 0.10) < 1e-9 && Math.abs(a.forgiveCritPct - cleared * 0.10) < 1e-9, { r: a.forgiveDmgRounds, d: a.forgiveDmgPct, c: a.forgiveCritPct });
}

console.log('== 10431 玄佑 ==');
{
  const a = mk({ id: 1, type: 1541033, hp: 1000, maxHp: 1000 });
  const mate = mk({ id: 2 });
  FC.applySkillEffects(a, cfg(10431), [a], [a, mate], 0, st());
  ok('对自身造成 60 威力伤害', a.hp < 1000, a.hp);
  ok('物防/魔防各 +1', a.statLevels[103] === 1 && a.statLevels[104] === 1, a.statLevels);
  ok('触发 3 次玄武天赋（0.2×3）', Math.abs((mate.xuanwuNextBonus || 0) - 0.6) < 1e-9 && Math.abs((a.xuanwuNextBonus || 0) - 0.6) < 1e-9, { mate: mate.xuanwuNextBonus, self: a.xuanwuNextBonus });
}

console.log('== 10432 羁绊连环 ==');
{
  const baihu = mk({ id: 1, type: 1544034 });
  const qinglong = mk({ id: 2, type: 1543031, lastUsedSkill: 10016 });
  const foe = mk({ id: 11, side: 1, hp: 5000, maxHp: 5000 });
  const all = [baihu, qinglong, foe];
  const bc = FC.bondChainCast(baihu, [qinglong], all, 0, st());
  ok('解析出青龙的追加行动', bc && bc.castBy === qinglong.id && bc.skillId === 10016, bc && { by: bc.castBy, sid: bc.skillId });
  ok('目标立即释放最后技能（敌人掉血）', foe.hp < 5000, foe.hp);
  const b2 = mk({ id: 3, type: 1544034 }), wrong = mk({ id: 4, type: 10001, lastUsedSkill: 10016 }), f2 = mk({ id: 12, side: 1 });
  const bc2 = FC.bondChainCast(b2, [wrong], [b2, wrong, f2], 0, st());
  ok('目标不是青龙/朱雀/玄武则不触发', bc2 === null && f2.hp === 1000, { bc2, hp: f2.hp });
}

console.log('== 22380 阿特拉斯死亡分摊可致死 ==');
{
  const atlas = mk({ id: 1, side: 0, type: 1434035, talent: 22380, hp: 1, maxHp: 3157 });
  const foe = mk({ id: 11, side: 1, hp: 60, maxHp: 60 });
  const killer = mk({ id: 12, side: 1, hp: 500, maxHp: 500 });
  // 直接调用包含死亡天赋的结算：让 killer 击倒 atlas
  const res = FC.settleSkill(killer, cfg(10016), [atlas], [atlas, foe], null, 0, st());
  const splash = (res.wakeEffects || []).find(e => Number(e.id) === 223801 && Number(e.change_type) === 200000);
  ok('死亡分摊允许致死且保留 223801 演出', !!splash && Math.abs(Number(splash.change_value[0])) === 60 && Number(splash.id) === 223801 && foe.hp === 0, splash);

}

console.log('== 21680 十香开局减防（选技前可见） ==');
{
  const tenka = mk({ id: 1, type: 2344004, talent: 21680 });
  const foe = mk({ id: 11, side: 1 });
  const eff = FC.applyTenkaOpeningDebuff([tenka, foe], 1);
  ok('随机 1 名敌人物防 -1', foe.statLevels[103] === -1 && foe.tohkaDefLowered === true && foe.tohkaTargeted === true, foe.statLevels);
  ok('返回减防 effect（entry/end 包下发）', eff.length === 1 && Number(eff[0].change_type) === 100000, eff);
}

console.log('== 21680 十香天赋：回复该次伤害 15% ==');
{
  const tohka = mk({ id: 1, type: 2344004, talent: 21680, hp: 500, maxHp: 1000 });
  const target = mk({ id: 2, side: 1, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
  target.tohkaTargeted = true;
  const res = FC.settleSkill(tohka, cfg(10016), [target], [tohka, target], null, 0, st());
  const dmg = Number((res.find(e => Number(e.target) === target.id) || {}).hurt) || 0;
  const healed = Math.round(tohka.hp) - 500;
  ok('造成伤害后物攻 +1', (tohka.statLevels[101] || 0) === 1, tohka.statLevels);
  ok('回复 = 伤害×15%', dmg > 0 && healed === Math.round(dmg * 0.15), { dmg, healed, expect: Math.round(dmg * 0.15) });
}

console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
