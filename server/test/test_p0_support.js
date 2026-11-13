// P0 辅助技能实现验证（纯服务端单元测试，不依赖游戏客户端）
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FC = require(path.join(ROOT, 'data/fight_core.js'));
const SE = require(path.join(ROOT, 'data/skill_effect_data.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function mkUnit(o) {
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
const cfgOf = id => FC.skillCfg(id);
const st = r => ({ round: r || 1, weather: null, selMap: {} });
const hpEffects = eff => eff.filter(e => Number(e.change_type) === 200000 && Array.isArray(e.change_value));

console.log('== 10186 飞升灵药 ==');
{
  const caster = mkUnit({ id: 1, type: 1535021 });
  const mate = mkUnit({ id: 2, type: 10001 });
  const foe = mkUnit({ id: 11, side: 1 });
  const all = [caster, mate, foe];
  const eff = FC.applySkillEffects(caster, cfgOf(10186), [mate], all, 0, st());
  ok('目标获得 ascendRounds=3', mate.ascendRounds === 3, mate.ascendRounds);
  const lv0 = mate.statLevels[101] || 0;
  FC.gainStat(mate, 101, 1, { effects: [], srcId: 10186, srcType: 3, atkId: caster.id, srcServantId: mate.id, phase: 4 });
  ok('提升能力等级额外 +1（1 级 → 2 级）', (mate.statLevels[101] || 0) === lv0 + 2, mate.statLevels[101]);
  // 必暴：固定随机数 0.99（非飞升时不会暴击），比较伤害
  const oldRnd = Math.random;
  function dmg(target) {
    const atk = mkUnit({ id: 5, side: 0, type: 10001, nature: 1 });
    const t = mkUnit({ id: 15, side: 1, type: 10001, nature: 1, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
    if (target) { t.ascendRounds = 3; }
    Math.random = () => 0.99;
    try { FC.settleSkill(atk, cfgOf(10016), [t], [atk, t], null, 0, st()); } catch (e) {}
    Math.random = oldRnd;
    return 5000 - Math.round(t.hp);
  }
  const d0 = dmg(false), d1 = dmg(true);
  ok('飞升目标被攻击必定暴击（伤害显著提高）', d1 > d0 * 1.2, { d0, d1 });
}

console.log('== 10245 圣光救赎 ==');
{
  const caster = mkUnit({ id: 1, type: 1143021 });
  const mate = mkUnit({ id: 2, hp: 500, maxHp: 1000 });
  mate.statLevels = { 101: -2, 102: -1, 103: 0, 104: 0, 105: 0 };
  const all = [caster, mate];
  const eff = FC.applySkillEffects(caster, cfgOf(10245), [mate], all, 0, st());
  ok('清除负面等级（101/102 归 0）', (mate.statLevels[101] || 0) === 0 && (mate.statLevels[102] || 0) === 0, mate.statLevels);
  const heal = hpEffects(eff).reduce((s, e) => s + e.change_value[0], 0);
  ok('回复 = 25% + 3级*5% = 40%最大生命', heal === 400, { heal, eff: hpEffects(eff) });
  ok('回复后 HP=900', Math.round(mate.hp) === 900, mate.hp);
}

console.log('== 10312 光坂的护佑 ==');
{
  const caster = mkUnit({ id: 1, type: 3145001 });
  const clannad = mkUnit({ id: 2, type: 3144002, maxHp: 1000 });
  const other = mkUnit({ id: 3, type: 10001, maxHp: 1000 });
  const all = [caster, clannad, other];
  FC.applySkillEffects(caster, cfgOf(10312), all.filter(x => x.side === 0), all, 0, st());
  ok('clannad 誓灵获得 15% 护盾', Number(clannad.shield) === 150, clannad.shield);
  ok('非 clannad 获得 10% 护盾', Number(other.shield) === 100, other.shield);
}

console.log('== 10314 熊之外套 ==');
{
  const caster = mkUnit({ id: 1, type: 3144002, level: 50 });
  const normal = mkUnit({ id: 2, type: 10001 });
  const clannad = mkUnit({ id: 3, type: 3146005 });
  FC.applySkillEffects(caster, cfgOf(10314), [normal], [caster, normal], 0, st());
  ok('普通目标护盾 = 50*6 = 300', Number(normal.shield) === 300, normal.shield);
  FC.applySkillEffects(caster, cfgOf(10314), [clannad], [caster, clannad], 0, st());
  ok('clannad 目标护盾 = 50*8 = 400', Number(clannad.shield) === 400, clannad.shield);
}

console.log('== 10353 纯洁之心 ==');
{
  const caster = mkUnit({ id: 1, type: 1235014 });
  const mate = mkUnit({ id: 2 });
  const foe = mkUnit({ id: 11, side: 1 });
  const all = [caster, mate, foe];
  FC.applySkillEffects(caster, cfgOf(10353), [mate], all, 0, st());
  ok('获得 3 回合免异常窗口', mate.noAbnormalRounds === 3, mate.noAbnormalRounds);
  ok('获得 pureHeartRounds=3', mate.pureHeartRounds === 3, mate.pureHeartRounds);
  // 毒雾（10096，100% 中毒）应被免异常拦下
  FC.applySkillEffects(foe, cfgOf(10096), [mate], all, 1, st());
  ok('免疫异常：中毒未生效', !(mate.buffs && mate.buffs[50005]), mate.buffs);
  const before = [101, 102, 103, 104, 105].reduce((s, p) => s + (mate.statLevels[p] || 0), 0);
  for (let r = 1; r <= 3; r++) FC.settleRoundEndTicks(all, st(r));
  const after = [101, 102, 103, 104, 105].reduce((s, p) => s + (mate.statLevels[p] || 0), 0);
  ok('3 回合结束共随机提升 3 级', after === before + 3, { before, after });
  ok('pureHeartRounds 到期归 0', (mate.pureHeartRounds || 0) === 0, mate.pureHeartRounds);
  ok('noAbnormalRounds 到期归 0', (mate.noAbnormalRounds || 0) === 0, mate.noAbnormalRounds);
}

console.log('== 10375 圣甲虫护壳 ==');
{
  const caster = mkUnit({ id: 1, type: 1635021, hp: 1000, maxHp: 1000 });
  const a2 = mkUnit({ id: 2, hp: 1000, maxHp: 1000 });
  const all = [caster, a2];
  const eff = FC.applySkillEffects(caster, cfgOf(10375), all, all, 0, st());
  ok('自损 30% 最大生命', Math.round(caster.hp) === 700, caster.hp);
  ok('己方获得 3 回合 25% 减伤', caster.teamDmgDownRounds === 3 && a2.teamDmgDownRounds === 3 && a2.teamDmgDownPct === 25);
  ok('己方获得 1 次异常免疫', caster.abnormalImmuneCharges === 1 && a2.abnormalImmuneCharges === 1);
  // 异常免疫一次：中毒被消耗
  FC.applySkillEffects(mkUnit({ id: 11, side: 1 }), cfgOf(10096), [a2], all, 1, st());
  ok('异常免疫消耗 1 次且未中毒', (a2.abnormalImmuneCharges || 0) === 0 && !(a2.buffs && a2.buffs[50005]), { charges: a2.abnormalImmuneCharges, buffs: a2.buffs });
  // 睡眠（WIKI 异常）同样应被拦：重新给一次 charge，催眠曲 10098
  const a2b = mkUnit({ id: 21, hp: 1000, maxHp: 1000 });
  FC.applySkillEffects(caster, cfgOf(10375), [a2b], [caster, a2b], 0, st());
  FC.applySkillEffects(mkUnit({ id: 12, side: 1 }), cfgOf(10098), [a2b], [caster, a2b], 1, st());
  ok('睡眠被免疫（消耗 charge）', (a2b.abnormalImmuneCharges || 0) === 0 && !(a2b.buffs && a2b.buffs[50004]), { charges: a2b.abnormalImmuneCharges, buffs: a2b.buffs });
  // 第二次睡眠（charge 已耗尽）应正常生效，验证“一次”口径
  FC.applySkillEffects(mkUnit({ id: 13, side: 1 }), cfgOf(10098), [a2b], [caster, a2b], 2, st());
  ok('第二次睡眠正常生效', !!(a2b.buffs && a2b.buffs[50004]), a2b.buffs);
  // 减伤：比较伤害
  const oldRnd = Math.random;
  function dmg(t) {
    const atk = mkUnit({ id: 5, side: 0, nature: 1 });
    const tt = mkUnit({ id: 15, side: 1, hp: 5000, maxHp: 5000, attrs: { hp: 5000, phy_atk: 100, mag_atk: 100, phy_def: 50, mag_def: 50, speed: 100 } });
    if (t) { tt.teamDmgDownRounds = 3; tt.teamDmgDownPct = 25; }
    Math.random = () => 0.5;
    try { FC.settleSkill(atk, cfgOf(10016), [tt], [atk, tt], null, 0, st()); } catch (e) {}
    Math.random = oldRnd;
    return 5000 - Math.round(tt.hp);
  }
  const d0 = dmg(false), d1 = dmg(true);
  ok('受到伤害降低约 25%', Math.abs(d1 / d0 - 0.75) < 0.02, { d0, d1 });
  // 已有减伤时追加随机防御/攻击 +1
  const caster2 = mkUnit({ id: 3, type: 1635021, hp: 1000, maxHp: 1000 });
  const a3 = mkUnit({ id: 4, hp: 1000, maxHp: 1000 });
  a3.nextInDmgDown = 0.3; // 已有减伤
  const sum0 = [101, 102, 103, 104, 105].reduce((s, p) => s + (a3.statLevels[p] || 0), 0);
  FC.applySkillEffects(caster2, cfgOf(10375), [a3], [caster2, a3], 0, st());
  const sum1 = [101, 102, 103, 104, 105].reduce((s, p) => s + (a3.statLevels[p] || 0), 0);
  ok('已有减伤 → 随机防御/攻击各 +1（总 +2）', sum1 === sum0 + 2, { sum0, sum1 });
}

console.log('== 10391 奉献誓约 ==');
{
  const tyr = mkUnit({ id: 1, type: 1045028, hp: 1000, maxHp: 1000 });
  const mate = mkUnit({ id: 2, hp: 1000, maxHp: 1000 });
  const foe = mkUnit({ id: 11, side: 1, hp: 5000, maxHp: 5000 });
  const all = [tyr, mate, foe];
  FC.applySkillEffects(tyr, cfgOf(10391), [tyr], all, 0, st());
  ok('失去当前 30% 生命', Math.round(tyr.hp) === 700, tyr.hp);
  ok('物防 +1', (tyr.statLevels[103] || 0) === 1, tyr.statLevels[103]);
  ok('魔防 +1', (tyr.statLevels[104] || 0) === 1, tyr.statLevels[104]);
  ok('敌方被吸引（tauntedBy=提尔）', Number(foe.tauntedBy) === 1, foe.tauntedBy);
  ok('吸引次数 tauntHitsLeft=3', tyr.tauntHitsLeft === 3, tyr.tauntHitsLeft);
  // 嘲讽重定向
  const redir = FC.targetsOfEff(1007, 1, all, mate, foe, 10016);
  ok('单体攻击目标被重定向到提尔', redir.length === 1 && redir[0].id === 1, redir.map(u => u.id));
  // 消耗 3 次
  const atkLv0 = (mate.statLevels[101] || 0) + (mate.statLevels[102] || 0);
  for (let i = 0; i < 3; i++) FC.settleSkill(foe, cfgOf(10016), [tyr], all, null, 0, st());
  ok('3 次后次数耗尽', (tyr.tauntHitsLeft || 0) === 0, tyr.tauntHitsLeft);
  ok('次数耗尽后吸引解除', foe.tauntedBy == null, foe.tauntedBy);
  const pending = (tyr.devotionAtkUpPending || 0) + (mate.devotionAtkUpPending || 0);
  ok('触发后挂起回合末加攻', pending === 2, pending);
  FC.settleRoundEndTicks(all, st(1));
  const atkLv1 = (mate.statLevels[101] || 0) + (mate.statLevels[102] || 0);
  ok('回合末己方全体较高攻击 +1', atkLv1 === atkLv0 + 1, { atkLv0, atkLv1, stats: mate.statLevels });
}

console.log('== 10426 灵归 ==');
{
  const caster = mkUnit({ id: 1, type: 1135041 });
  const mate = mkUnit({ id: 2, hp: 500, maxHp: 1000 });
  const mate2 = mkUnit({ id: 3, hp: 500, maxHp: 1000 });
  const all = [caster, mate, mate2];
  const res = FC.settleSkill(caster, cfgOf(10426), [mate], all, null, 0, st());
  FC.applySkillEffects(caster, cfgOf(10426), [mate], all, 0, st());
  ok('目标回复 25%（500 → 750）', Math.round(mate.hp) === 750, mate.hp);
  ok('其他己方回复一半（500 → 625）', Math.round(mate2.hp) === 625, mate2.hp);
  const heals = res.filter(e => Number(e.hurt) < 0).map(e => e.target + ':' + (-e.hurt)).sort();
  ok('results 含 2 条治疗（客户端能显示飘字）', heals.length === 2, heals);
  // 目标满血时其他队友仍要回血
  const c2 = mkUnit({ id: 4, type: 1135041 });
  const full = mkUnit({ id: 5, hp: 1000, maxHp: 1000 });
  const hurtMate = mkUnit({ id: 6, hp: 400, maxHp: 1000 });
  const res2 = FC.settleSkill(c2, cfgOf(10426), [full], [c2, full, hurtMate], null, 0, st());
  ok('目标满血时其他队友照常 +12.5%（400 → 525）', Math.round(hurtMate.hp) === 525, hurtMate.hp);
  ok('满血目标 results 也有 0 治疗条目', res2.some(e => e.target === full.id), res2);
}

console.log('== 10132 痊愈之颂咏：清除 WIKI 异常 ==');
{
  const caster = mkUnit({ id: 1, type: 10001 });
  const mate = mkUnit({ id: 2, hp: 800, maxHp: 1000 });
  mate.buffs = { 50005: { level: 1, duration: 3 }, 50007: { level: 1, duration: 3 }, 50002: { level: 1, duration: 3 } };
  mate.flinch = true;
  const all = [caster, mate];
  const eff = FC.applySkillEffects(caster, cfgOf(10132), [mate], all, 0, st());
  ok('中毒/混乱/烧伤全部清除', !(mate.buffs[50005] || mate.buffs[50007] || mate.buffs[50002]), mate.buffs);
  ok('畏惧(flinch)清除', mate.flinch === false, mate.flinch);
  ok('下发 300020 摘图标事件', eff.filter(e => Number(e.change_type) === 300020).length === 3, eff.length);
}

console.log('\n结果: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
