module("CopyModule", package.seeall)
require("Modules.Copy.View.AutoGen.CopyRewardPanelAutoGen")

function CopyRewardPanel.initUI(slot0)
	slot0.expItemList = {}
	slot0.detailItemList = {}

	for slot4 = 1, 6 do
		slot5 = slot0:create(CopyRewardServantItem)

		slot5:setParent(slot0.goRewardServant.transform)
		slot5:setAnchorPosition(Vector2(490 - 195 * (slot4 - 1), -38))

		slot0.expItemList[7 - slot4] = slot5

		slot5:setActive(false)
	end

	for slot4 = 1, 6 do
		slot5 = slot0:create(CopyRewardDetailItem)

		slot5:setParent(slot0.objDetailMask)

		slot5.itemIndex = 6 - slot4

		slot5:setAnchorPosition(Vector2(490 - 195 * (slot4 - 1), -38))

		slot0.detailItemList[7 - slot4] = slot5

		slot5:setActive(false)
	end

	slot0.buffView = slot0:create(RoleModule.RoleBuffView, {
		isShort = true
	})

	slot0.buffView:setParent(slot0.tran)
	slot0.buffView:setScale()
	slot0.buffView:setAnchorPosition(Vector2(310, 155))

	slot0.texResult.material = ComponentUtil.CreateMaterial("UI/Light")
	slot0.imgRight = slot0:getChildComponent("imgRight", "UnityEngine.UI.Image")
	slot0.imgLeft = slot0:getChildComponent("imgLeft", "UnityEngine.UI.Image")

	UIEventListener.AddClick(slot0.goClick1, luaHandler(slot0, "onClick", slot0))
	UIEventListener.AddClick(slot0.goClick2, luaHandler(slot0, "onOK", slot0))
	UIEventListener.AddClick(slot0.goClick3, luaHandler(slot0, "onSkip", slot0))
	slot0.btnDetail:AddClick(luaHandler(slot0, "onDetail", slot0))

	slot0.spBtnDetail = slot0:getChildComponent("btnDetail", "CSprite")

	slot0.btnReplay:AddClick(luaHandler(slot0, "onClickReplay", slot0))

	slot0.spBtnReplay = slot0:getChildComponent("btnReplay", "CSprite")

	UIEventListener.AddClick(slot0.goDetail, luaHandler(slot0, "onHideDetail", slot0))

	slot0.listReward.LuaItemRender = CopyRewardBagItem
	slot0.listReward.LuaItemRenderOption = {
		AddClickEvent = function ()
			CopyMgr.isPlayerRealClick = true
		end
	}
	slot0.imgRight = slot0:create(CImage)

	slot0.imgRight:initImg(slot0:getChildComponent("imgRight", "UnityEngine.UI.Image"))

	slot0.imgLeft = slot0:create(CImage)

	slot0.imgLeft:initImg(slot0:getChildComponent("imgLeft", "UnityEngine.UI.Image"))

	slot0.rewardTimeout = {}
	slot0.chatView = slot0:create(ChatModule.ChatMiniView)

	slot0.chatView:setParent(slot0, true)
	slot0:setParent(LayerManager.broadcastLayer, true)
	slot0:setSortingOrder(LayerManager.getWindowHighLayerSortingOrder() + 900)
	slot0:addMessageListener(ModuleCommand.CHAT_DETAIL_CLICK, selfHandler(slot0, "onChatDetailPanelClick"))
	UIEventListener.AddClick(slot0.goReplaceMask, selfHandler(slot0, "checkReplace"))
end

function CopyRewardPanel.onChatDetailPanelClick(slot0)
	if slot0.myObj == nil or not slot0:isActive() then
		return
	end

	ChatModule.ChatDetailPanel.clickClose = false

	if Time.time - slot0.openTime < 1.5 then
		return
	end

	slot0.openTime = Time.time

	if slot0.goFirstPage.activeSelf then
		slot0:onHideDetail()
		slot0:onClick()
	elseif slot0.goReward.activeSelf then
		slot0:onOK()
	end
end

function CopyRewardPanel.onClickBtnNext(slot0)
	return
end

function CopyRewardPanel.open(slot0)
	slot0.step = 1

	slot0:setActive(true)
end

function CopyRewardPanel.onOpen(slot0)
	slot0.openTime = Time.time
	slot0.resultVO = nil

	for slot4, slot5 in ipairs(slot0.expItemList) do
		slot5:setActive(false)
	end

	for slot4, slot5 in ipairs(slot0.detailItemList) do
		slot5:setActive(false)
	end

	if OutCardMgr.hasServant() then
		OutCardModule.preLoadOutCardAssets()
	end
end

function CopyRewardPanel.onGUI(slot0)
	printLxf("onGUI" .. FightMgr.getNowFightID())

	if slot0.resultVO ~= nil or slot0:isActive() == false then
		return
	end

	slot0.buffView:setActive(false)
	slot0.buffView:setData("updateBuffs")

	slot0.firstShowDetail = true
	CopyMgr.isPlayerRealClick = false

	Util.setActive(slot0.goClick1, false)
	Util.setActive(slot0.goFirstPage, true)
	Util.setActive(slot0.goDetail, false)
	Util.setActive(slot0.btnDetail, false)
	Util.setActive(slot0.btnReplay, false)
	Util.setActive(slot0.goFailure, false)
	Util.setActive(slot0.texReplace, false)
	Util.setActive(slot0.goTouch, true)
	slot0.chatView:checkCanShow()

	slot0.resultVO = CopyMgr.getResult(FightMgr.getNowFightID())
	slot0.listReward.LuaDataProvider = {}

	slot0.listReward:DataChanged(true)

	slot2 = GuideModule.isSecondFight()
	slot3 = GuideModule.isFirstFight()
	slot4 = CopyMgr.isFeelingCopy()
	slot5 = CopyMgr.isTowerCopy()
	slot6 = CopyMgr.isPvpBattle()
	slot11 = CopyConfig.getCopyVO(CopyMgr.nowCopyId)
	slot0.extraMode = slot11.extraMode
	slot0.expType = slot11.extraMode
	slot0.showKill = slot0.extraMode == 2
	slot0.showScore = slot0.extraMode == 3
	slot0.showStar = slot0.extraMode == 1 or slot0.extraMode == nil
	slot0.killName = slot11.killName
	slot0.scoreName = slot11.scoreName
	slot0.showStar = slot0.showStar and (not slot0.showKill and not slot0.showScore and not slot2 and not slot3 and not slot4 and not slot5 and not slot6 and not CopyMgr.isDareCopy() and not CopyMgr.isMazeBattle() and not CopyMgr.isMazeSpecial() and not CopyMgr.isDreamReady())

	slot0.goRoleInfo:SetActive(not slot0.showKill and not slot0.showScore and not slot2 and not slot3 and not slot4 and not slot5 and not slot6)
	slot0.goReward:SetActive(false)

	slot0.showFailure = false

	Util.setActive(slot0.goScore, slot0.showScore)

	if slot1 then
		Util.setActive(slot0.goReplaceMask, slot0.resultVO.needReplace)

		slot0.showFailure = not slot0.resultVO:isWin() and not CopyMgr.isPvpBattle() and CopyMgr.nowCopyId ~= CopyConst.COPY_BILI and not CopyConst.isAutoEliminate()

		if slot0.showFailure then
			slot0.tex6.Path = "UI/Copy/Textures/LosePannelBg"
			slot0.texFrameRight.Path = "UI/Copy/Textures/LoseOrnament2"
			slot0.texFrameLeft.Path = "UI/Copy/Textures/LoseOrnament2"
			slot0.texFrameBot1.Path = "UI/Copy/Textures/LoseOrnament1"
			slot0.texFrameBot2.Path = "UI/Copy/Textures/LoseOrnament1"
			slot0.texFrameTop1.Path = "UI/Copy/Textures/LoseOrnament1"
			slot0.texFrameTop2.Path = "UI/Copy/Textures/LoseOrnament1"
			slot0.texDetailBack.Path = "UI/Copy/Textures/BackLose"

			slot0.imgRight:setPath("UI/CommonTile/Textures/LoseOrnament3")
			slot0.imgLeft:setPath("UI/CommonTile/Textures/LoseOrnament3")

			slot0.spBtnDetail.SpriteName = "DetailButtonLose"
			slot0.spBtnReplay.SpriteName = "ReplayButtonLose"
		else
			slot0.tex6.Path = "UI/Copy/Textures/WinPannelBg"
			slot0.texFrameRight.Path = "UI/Copy/Textures/WinOrnament2"
			slot0.texFrameLeft.Path = "UI/Copy/Textures/WinOrnament2"
			slot0.texFrameBot1.Path = "UI/Copy/Textures/WinOrnament1"
			slot0.texFrameBot2.Path = "UI/Copy/Textures/WinOrnament1"
			slot0.texFrameTop1.Path = "UI/Copy/Textures/WinOrnament1"
			slot0.texFrameTop2.Path = "UI/Copy/Textures/WinOrnament1"
			slot0.texDetailBack.Path = "UI/Copy/Textures/BackWin"

			slot0.imgRight:setPath("UI/CommonTile/Textures/WinOrnament3")
			slot0.imgLeft:setPath("UI/CommonTile/Textures/WinOrnament3")

			slot0.spBtnDetail.SpriteName = "DetailButtonWin"
			slot0.spBtnReplay.SpriteName = "ReplayButtonWin"
		end

		slot0.texResult.Path = slot1:getResultPath()

		Util.setActive(slot0.goExtra, slot0.showStar)
		Util.setActive(slot0.goExp, not slot4 and not slot5 and not slot0.showFailure)

		slot0.extraDic = {}

		for slot17, slot18 in pairs(slot1.star) do
			slot0.extraDic[slot18.id] = slot18.val
		end

		if slot0.showScore then
			slot0:dealShowScore()
		end

		if CopyMgr.isTowerCopy() and not slot0.resultVO:isWin() then
			TowerMgr.setIsAutoFightInBattle(false)
		end

		slot0:animationBaseIn()
	elseif slot3 then
		slot0:animationBaseIn()
	else
		Util.setActive(slot0.goClick1, true)
		printLxf("没数据")
	end
end

function CopyRewardPanel.onClickReplay(slot0)
	lastRecordID = FightRecordMgr:getLastRecordID()

	if lastRecordID then
		FightRecordUtil.prepareToPlayRecord(lastRecordID, 2)
		slot0:setActive(false)
		LayerManager.showWindowLayer()
	end
end

function CopyRewardPanel.onDetail(slot0)
	CopyMgr.isPlayerRealClick = true

	Util.setActive(slot0.goFailure, false)
	Util.setActive(slot0.btnDetail, false)
	Util.setActive(slot0.btnReplay, false)
	Util.setActive(slot0.goRewardServant, false)
	Util.setActive(slot0.goDetail, true)
	Util.setActive(slot0.goTouch, false)

	for slot4, slot5 in ipairs(slot0.detailItemList) do
		slot5:show(slot0.resultVO.maxMvpStats, slot0.firstShowDetail, slot0.resultVO:isWin(), slot0.resultVO.mvpStatsCount)
	end

	slot0.firstShowDetail = false
end

function CopyRewardPanel.onHideDetail(slot0)
	Util.setActive(slot0.btnDetail, true)
	Util.setActive(slot0.btnReplay, slot0.isShowReplay)
	Util.setActive(slot0.goTouch, true)
	Util.setActive(slot0.goFailure, slot0.showFailure)
	Util.setActive(slot0.goRewardServant, slot0.showFailure == false)
	Util.setActive(slot0.goDetail, false)
end

function CopyRewardPanel.animationBaseIn(slot0)
	Util.setActive(slot0.objFram, false)
	Util.setActive(slot0.goExp, false)

	slot0.tex6.Alpha = 0

	slot0.tex6:DOFade(1, 1)
	Util.setActive(slot0.imgRight, false)
	Util.setActive(slot0.imgLeft, false)
	slot0.texResult.material:SetFloat("_Light", 1)
	LoopManager.setTimeout(function ()
		uv0:animationFrameIn(true)
	end, 0.5)
	LoopManager.setTimeout(function ()
		uv0:animationBaseIn2()
	end, 0.5)
	LoopManager.setTimeout(function ()
		uv0:animationExpIn()
	end, 0.8)
end

function CopyRewardPanel.animationBaseIn2(slot0)
	Util.setActive(slot0.imgRight, true)
	Util.setActive(slot0.imgLeft, true)

	slot0.imgRight.transform.sizeDelta = Vector2(46, 78)
	slot0.imgLeft.transform.sizeDelta = Vector2(46, 78)

	slot0.imgLeft.transform:DOSizeDelta(Vector2(46, 540), 0.5)
	slot0.imgRight.transform:DOSizeDelta(Vector2(46, 540), 0.5)
end

function CopyRewardPanel.animationFrameIn(slot0, slot1)
	Util.setActive(slot0.objFram, true)

	slot0.texFrameLeft.Alpha = 0
	slot0.texFrameRight.Alpha = 0

	slot0.texFrameLeft:DOFade(1, 0.5)
	slot0.texFrameRight:DOFade(1, 0.5)

	slot0.texFrameLeft.transform.anchoredPosition = Vector2(-61, 0)
	slot0.texFrameRight.transform.anchoredPosition = Vector2(61, 0)

	slot0.texFrameLeft.transform:DOLocalMoveX(-524, 0.5)
	slot0.texFrameRight.transform:DOLocalMoveX(524, 0.5)
	MingUIUtil.SetGroupAlpha(slot0.objFrameTop.gameObject, 0)
	MingUIUtil.SetGroupAlpha(slot0.objFrameBot.gameObject, 0)
	MingUIUtil.SetGroupAlphaInTime(slot0.objFrameTop.gameObject, 1, 0.5, Ease.Linear, nil)
	MingUIUtil.SetGroupAlphaInTime(slot0.objFrameBot.gameObject, 1, 0.5, Ease.Linear, nil)

	slot0.objFrameTop.anchoredPosition = Vector2(0, 0)
	slot0.objFrameBot.anchoredPosition = Vector2(0, 0)

	slot0.objFrameTop:DOLocalMoveY(317, 0.5)
	slot0.objFrameBot:DOLocalMoveY(-317, 0.5)

	slot0.imgFrameCenter1.transform.sizeDelta = Vector2(46, 12)

	slot0.imgFrameCenter1.transform:DOSizeDelta(Vector2(880, 12), 0.5)

	slot0.imgFrameCenter2.transform.sizeDelta = Vector2(46, 20)

	slot0.imgFrameCenter2.transform:DOSizeDelta(Vector2(938, 20), 0.5)

	if slot1 then
		slot0.texResult.material:SetFloat("_Alpha", 0)
		LoopManager.setTimeout(function ()
			uv0.texResult.material:SetFloat("_Alpha", 0.2)
			uv0.texResult.material:DOFloat(1, "_Alpha", 0.5)

			uv0.texResult.transform.anchoredPosition = Vector3(-320, 211)

			uv0.texResult.transform:DOLocalPath({
				Vector3(-240, 211),
				Vector3(-269.5, 211)
			}, 0.4, DG.Tweening.PathType.CatmullRom, DG.Tweening.PathMode.Ignore, 10, Color(0, 0, 0, 0))
			uv0.texResult.material:SetFloat("_Light", 1)
			LoopManager.setTimeout(function ()
				uv0.texResult.material:SetFloat("_Light", 8)
				LoopManager.setTimeout(function ()
					uv0.texResult.material:SetFloat("_Light", 1)
				end, 0.1)
			end, 0.15)
		end, 0.2)
	end

	LoopManager.setTimeout(function ()
		MingUIUtil.SetGroupAlphaInTime(uv0.objFram.gameObject, 0.4, 0.1, Ease.Linear, nil)
	end, 0.5)
	LoopManager.setTimeout(function ()
		MingUIUtil.SetGroupAlphaInTime(uv0.objFram.gameObject, 1, 0.1, Ease.Linear, nil)
	end, 0.6)
end

function CopyRewardPanel.animationExpIn(slot0)
	Util.setActive(slot0.goExp, not slot0.showFailure)
	Util.setActive(slot0.goFailure, slot0.showFailure)
	slot0.goClick1:SetActive(false)

	slot0.texLightName.Alpha = 0
	slot0.texLightLv.Alpha = 0

	LoopManager.setTimeout(function ()
		uv0.texLightName:DOFade(1, 0.2)
	end, 0.1)
	LoopManager.setTimeout(function ()
		DOTween.Kill(uv0.texLightName.transform)
		uv0.texLightName:DOFade(0, 0.2)
	end, 0.3)
	LoopManager.setTimeout(function ()
		uv0.texLightLv:DOFade(1, 0.2)
	end, 0.1)
	LoopManager.setTimeout(function ()
		DOTween.Kill(uv0.texLightLv.transform)
		uv0.texLightLv:DOFade(0, 0.2)
	end, 0.3)
	LoopManager.setTimeout(function ()
		uv0.goClick1:SetActive(true)

		if GuideModule.isFirstFight() == false and GuideModule.isSecondFight() == false then
			Util.setActive(uv0.btnDetail, true)
		end

		uv0.isShowReplay = CopyMgr.isMiraclesBattle()

		Util.setActive(uv0.btnReplay, uv0.isShowReplay)

		if uv0:isTowerAutoFight() and false then
			uv0:onClick()

			uv0.delayIDKey = LoopManager.setTimeout(function ()
				uv0:onOK()
			end, 1.2)
		end

		if CopyMgr.getAutoSkip() then
			CopyMgr.isPlayerRealClick = false
			uv0.autoSkip1IDKey = LoopManager.setTimeout(function ()
				if not CopyMgr.isPlayerRealClick then
					uv0:onClick(true)
				end
			end, CopyConst.COPY_AUTO_SKIP_TIME)
		end
	end, 1)

	if slot0.showFailure then
		MingUIUtil.SetGroupAlpha(slot0.spFailureTips1.gameObject, 0)
		MingUIUtil.SetGroupAlpha(slot0.spFailureTips2.gameObject, 0)
		MingUIUtil.SetGroupAlpha(slot0.spFailureTips3.gameObject, 0)
		LoopManager.setTimeout(function ()
			MingUIUtil.SetGroupAlphaInTime(uv0.spFailureTips1.gameObject, 1, 0.3, Ease.Linear, nil)
		end, 0.3)
		LoopManager.setTimeout(function ()
			MingUIUtil.SetGroupAlphaInTime(uv0.spFailureTips2.gameObject, 1, 0.3, Ease.Linear, nil)
		end, 0.6)
		LoopManager.setTimeout(function ()
			MingUIUtil.SetGroupAlphaInTime(uv0.spFailureTips3.gameObject, 1, 0.3, Ease.Linear, nil)
		end, 0.9)
	end

	slot0:updateExpInfo()

	if slot0.resultVO == nil or slot0.resultVO:isWin() then
		slot0.buffView:setActive(true)
	end
end

function CopyRewardPanel.isTowerAutoFight(slot0)
	return CopyMgr.isTowerCopy() and TowerMgr.getIsAutoFightInBattle() and slot0.resultVO and slot0.resultVO:isWin()
end

function CopyRewardPanel.updateExpInfo(slot0)
	if GuideModule.isFirstFight() then
		for slot6 = 1, 3 do
			slot7 = CopyRewardServantVO.new()
			slot7.isMVP = slot6 == 3
			slot7.isWin = true
			slot7.typeID = ({
				1544001,
				1124001,
				1341001
			})[slot6]

			slot0.expItemList[slot6]:setData(slot7)
		end

		slot3 = 3

		for slot8 = 1, slot3 do
			slot0.expItemList[slot8]:setAnchorPosition(Vector2(-1 * (1 * slot3 * 212 / 2 - 106 - 212 * (slot8 - 1)), -38))
		end
	elseif slot0.resultVO ~= nil then
		slot2 = slot0.resultVO.roleExp
		slot0.lblLv.text = "Lv " .. GlobalData.level
		slot0.lblRoleName.text = GlobalData.roleName
		slot0.lblExp.text = "EXP+" .. tostring(slot2)

		printLxf(slot2)

		if GlobalData.exp < slot2 then
			slot0.pbExp.value = (GlobalData.nextLevelExp - (slot2 - GlobalData.exp)) / GlobalData.nextLevelExp
		else
			slot0.pbExp.value = (GlobalData.exp - slot2) / GlobalData.nextLevelExp
		end

		slot0.pbExp:SetValueByTween(GlobalData.exp / GlobalData.nextLevelExp, slot3, 1, nil)
		slot0:updateRewardServant()
	end
end

function CopyRewardPanel._updateRewardServantImpl(slot0)
	-- 本地服补丁（2026-11-13）：队伍全灭战败时 FormationMgr 可能已清空，原版会在
	-- slot7.fight_field 处 attempt to index a nil value（CopyRewardPanel LuaError）。
	if slot0.resultVO == nil then return end
	slot2 = slot0.resultVO.mvpServantID
	slot3 = slot0.resultVO.result == FightConst.RESULT_WIN
	slot4 = {}
	slot5 = false
	slot6 = CopyMgr.getTeamIndex(CopyUtil.getCopyType(CopyMgr.nowCopyId))

	if GuideModule.isSecondFight() then
		slot6 = 1
	end

	if CopyMgr.isDreamReady() then
		slot7 = {}

		for slot11, slot12 in ipairs(DreamMgr.getMainServants()) do
			table.insert(slot7, slot12.id)
		end

		slot0:createServantVOByIDArr(slot7, slot4)
	elseif CopyMgr.isLinkCopy() and ActCopyMgr.checkRoom() then
		slot0:createServantVOByIDArr({
			ActCopyMgr.curRoomVO:getMyServant().pTeamServant.id
		}, slot4)
	elseif CopyMgr.isCopyPhantom() then
		for slot10, slot11 in ipairs(slot0.resultVO.servantMvpStats) do
			slot14 = CopyRewardServantVO.new()
			slot14.id = 0
			slot14.servantVO = ServantUtil.changeToPhantom(ServantConfig.getServantConfigVO(slot11.id))

			table.insert(slot4, slot14)
		end
	else
		slot7 = CopyMgr.getTeamFormation(slot6)

		-- 本地服补丁：战败时 FormationMgr.getFormation 可能返回 nil
		if slot7 == nil then return end

		slot0:createServantVOByIDArr(slot7.fight_field, slot4)
		slot0:createServantVOByIDArr(slot7.fight_bench, slot4)
	end

	if slot0.step == 1 then
		for slot10, slot11 in ipairs(slot4) do
			slot11.exp = slot1:getServantExp(slot11.id)
			slot11.expType = slot1:getServantExpType(slot11.id)
			slot11.isMVP = slot2 == slot11.id
			slot11.teamIndex = slot6
			slot11.isWin = slot3

			if slot11.isMVP then
				slot12 = slot11:getServantVO()

				HandbookModule.playServantCV(slot12.typeId, HandbookConfig.getServantCopyEndDialog(slot12.typeId, slot3).id)
			end

			if slot0.expItemList[slot10] == nil then break end
			slot0.expItemList[slot10]:setData(slot11)

			slot5 = slot5 or slot11:isUp()
		end

		slot7 = #slot4

		for slot12 = 1, slot7 do
			slot0.expItemList[slot12]:setAnchorPosition(Vector2(-1 * (1 * slot7 * 212 / 2 - 106 - 212 * (slot12 - 1)), -38))
		end

		slot7 = 0
		slot9 = 1 * slot0.resultVO.mvpStatsCount * 185 / 2 - 92.5

		for slot13, slot14 in ipairs(slot0.resultVO.servantMvpStats) do
			if not slot0.detailItemList[slot7 + 1] then
				break
			end

			slot15:setData(slot14)
			slot15:setAnchorPosition(Vector2(-1 * (slot9 - 185 * (slot7 - 1)), 42))
		end
	end

	if slot5 then
		AudioManager.playAudio(1006)
	else
		AudioManager.playAudio(1005)
	end
end

-- 本地服补丁：战败结算数据/阵型缺失时兜底，绝不让面板动画循环抛 LuaError
function CopyRewardPanel.updateRewardServant(slot0)
	local ok, err = pcall(CopyRewardPanel._updateRewardServantImpl, slot0)
	if not ok then
		printLbz("CopyRewardPanel.updateRewardServant pcall:", err)
	end
end

function CopyRewardPanel.createServantVOByIDArr(slot0, slot1, slot2)
	-- 本地服补丁：战败/异常结算时阵容数组可能为 nil
	if slot1 == nil then return end
	for slot6, slot7 in ipairs(slot1) do
		if slot0.resultVO:checkServantShow(slot7) then
			slot8 = CopyRewardServantVO.new()
			slot8.id = slot7

			table.insert(slot2, slot8)
		end
	end
end

function CopyRewardPanel.onSkip(slot0)
	slot0.goClick3:SetActive(false)

	for slot4, slot5 in pairs(slot0.rewardTimeout) do
		LoopManager.clearTimeout(slot5)
	end

	LoopManager.setTimeout(function ()
		uv0.goClick2:SetActive(true)
	end, 0.5)

	for slot7 = 1, 3 do
		if #CopyConfig.getCopyDetail(CopyMgr.getResult(FightMgr.getNowFightID()).copyID).extraCondition < slot7 then
			slot0["goExtra" .. slot7]:SetActive(false)
		else
			slot0["goExtra" .. slot7]:SetActive(true)
			slot0["spExtraLight" .. slot7].gameObject:SetActive(false)
		end
	end
end

function CopyRewardPanel.onClick(slot0, slot1)
	if slot1 == true then
		CopyMgr.isPlayerRealClick = false
	else
		CopyMgr.isPlayerRealClick = true
	end

	Util.setActive(slot0.goClick1, false)

	if GuideModule.isFirstFight() then
		slot0:setActive(false)
		FightNavModule.quitFight(FightConst.RESULT_WIN)

		return
	end

	slot2 = slot0.resultVO

	if slot0.showFailure or slot2 == nil or CopyMgr.isFeelingCopy() or CopyMgr.isAreaBattle() or CopyMgr.isLadderBattle() then
		printLbz("showFailure:", slot0.showFailure, slot2 == nil)
		slot0:onOK()

		return
	end

	slot0.step = 2

	slot0.goReward:SetActive(true)
	Util.setActive(slot0.goFirstPage, false)
	slot0.goClick2:SetActive(false)
	slot0.goClick3:SetActive(false)
	LoopManager.setTimeout(function ()
		uv0.goClick2:SetActive(true)
		uv0.goClick3:SetActive(false)

		uv0.autoSkip2IDKey = LoopManager.setTimeout(function ()
			if not CopyMgr.isPlayerRealClick then
				uv0:onOK(true)
			end
		end, CopyConst.COPY_AUTO_SKIP_TIME)
	end, 2)
	slot0:animationFrameIn()

	slot0.rewardTimeout = {}
	slot0.fightCopyID = CopyMgr.isMainCopy() and CopyMgr.nowCopyPointID or CopyMgr.nowCopyId

	Util.setActive(slot0.goKill, slot0.showKill)

	slot3 = 0

	if slot0.showKill then
		slot0:dealShowKill()

		slot3 = 2
	elseif slot0.showStar then
		slot3 = slot0:dealShowStar()
	end

	slot0:dealShowRewards(slot3)
end

function CopyRewardPanel.dealShowScore(slot0)
	slot0.lblScoreName.text = slot0.scoreName or ""
	slot1 = ""
	slot0.lblScore.text = slot0.resultVO.score .. HtmlUtil.Color(string.csformat(slot0.resultVO:isWin() and "(+{0})" or "(-{0})", math.abs(slot0.resultVO.addScore)), slot0.resultVO:isWin() and "57f8a8" or "ffaaaa")

	MingUIUtil.SetGroupAlpha(slot0.goScore1, 0)
	MingUIUtil.SetGroupAlpha(slot0.goScore2, 0)
	slot0:setRewardTimeout(function ()
		uv0:animationKillIn(1, "goScore", "spScoreLight")
	end, 0.5)
	slot0:setRewardTimeout(function ()
		uv0:animationKillIn(2, "goScore", "spScoreLight")
	end, 0.5)
end

function CopyRewardPanel.dealShowKill(slot0)
	slot0.lblKillName.text = slot0.killName or ""
	slot0.lblKill.text = slot0.resultVO.killNum
	slot0.ilblKillGrade.Text = CopyConfig.getKillGrade(CopyMgr.nowCopyId, slot0.resultVO.killNum)

	MingUIUtil.SetGroupAlpha(slot0.goKill1, 0)
	MingUIUtil.SetGroupAlpha(slot0.goKill2, 0)
	slot0:setRewardTimeout(function ()
		uv0:animationKillIn(1)
	end, 0.5)
	slot0:setRewardTimeout(function ()
		uv0:animationKillIn(2)
	end, 0.5)
end

function CopyRewardPanel.dealShowStar(slot0)
	slot2 = #CopyConfig.getCopyDetail(slot0.resultVO.copyID).extraCondition

	for slot6 = 1, 3 do
		if slot2 < slot6 then
			slot0["goExtra" .. slot6]:SetActive(false)
		else
			slot0["goExtra" .. slot6]:SetActive(true)

			slot7 = slot1.extraCondition[slot6]
			slot0["lblExtra" .. slot6].text = CopyUtil.getCopyExtraConditionStr(slot7[2], slot7[3], slot7[4])

			if slot0.extraDic[slot6] == 1 then
				slot0["goDoneExtra" .. slot6]:SetActive(true)
				slot0["goNoneExtra" .. slot6]:SetActive(false)
			else
				slot0["goDoneExtra" .. slot6]:SetActive(false)
				slot0["goNoneExtra" .. slot6]:SetActive(true)
			end

			MingUIUtil.SetGroupAlpha(slot0["goExtra" .. slot6], 0)
			slot0["spExtraLight" .. slot6].gameObject:SetActive(false)
			slot0:setRewardTimeout(function ()
				uv0:animationExtraIn(uv1)
			end, 0.2 * (slot6 - 1) + 0.5)
		end
	end

	return slot2
end

function CopyRewardPanel.dealShowRewards(slot0, slot1)
	if table.nums(slot0.resultVO.showRewards) == 0 then
		if slot0.showKill then
			slot0:dealShowKill()
		else
			slot0:onOK()
		end
	else
		slot3 = -3

		if #slot2 <= 6 then
			slot3 = -65
		end

		slot0.listReward.transform.anchoredPosition = Vector2(Mathf.Min(6, #slot2) / -2 * 142 + 420, slot3)

		slot0:setRewardTimeout(function ()
			uv0.listReward.LuaDataProvider = uv1

			TweenUtil.clistTweenIn(uv0.listReward, TweenUtil.SCROLL_TOP)
		end, 0.2 * (slot1 + 1) + 0.5)

		slot0.showRewards = slot2
	end
end

function CopyRewardPanel.setRewardTimeout(slot0, slot1, slot2)
	table.insert(slot0.rewardTimeout, LoopManager.setTimeout(slot1, slot2))
end

function CopyRewardPanel.animationExtraIn(slot0, slot1)
	MingUIUtil.SetGroupAlphaInTime(slot0["goExtra" .. slot1], 1, 0.2, Ease.Linear, nil)
	table.insert(slot0.rewardTimeout, LoopManager.setTimeout(function ()
		uv0["spExtraLight" .. uv1].gameObject:SetActive(true)

		uv0["spExtraLight" .. uv1].Alpha = 1

		uv0["spExtraLight" .. uv1]:DOFade(0, 0.2)
	end, 0.2))
end

function CopyRewardPanel.animationKillIn(slot0, slot1, slot2, slot3)
	slot3 = slot3 or "spKillLight"

	MingUIUtil.SetGroupAlphaInTime(slot0[(slot2 or "goKill") .. slot1], 1, 0.2, Ease.Linear, nil)
	table.insert(slot0.rewardTimeout, LoopManager.setTimeout(function ()
		uv0[uv1 .. uv2].gameObject:SetActive(true)

		uv0[uv1 .. uv2].Alpha = 1

		uv0[uv1 .. uv2]:DOFade(0, 0.2)
	end, 0.2))
end

function CopyRewardPanel.onOK(slot0, slot1)
	if slot1 == true then
		CopyMgr.isPlayerRealClick = false
		OutCardMgr.skipOutCard = true
	else
		CopyMgr.isPlayerRealClick = true
	end

	slot0:close()
end

function CopyRewardPanel.checkReplace(slot0)
	for slot5 = 0, slot0.listReward.LuaItemRenders.Length - 1 do
		if slot1[slot5] ~= nil then
			slot1[slot5]:checkReplace()
		end
	end

	Util.setActive(slot0.texReplace, true)
	Util.setActive(slot0.goTouch, false)
	Util.setActive(slot0.goReplaceMask, false)

	if slot0.resultVO then
		slot0.resultVO.needReplace = false
	end
end

function CopyRewardPanel.onRelease(slot0)
	return
end

function CopyRewardPanel.close(slot0)
	if slot0.resultVO and slot0.resultVO.needReplace then
		slot0:checkReplace()
	else
		slot0:setActive(false)
		LoopManager.clearTimeout(slot0.delayIDKey)

		slot0.delayIDKey = nil

		if slot0.autoSkip1IDKey then
			LoopManager.clearTimeout(slot0.autoSkip1IDKey)

			slot0.autoSkip1IDKey = nil
		end

		if slot0.autoSkip2IDKey then
			LoopManager.clearTimeout(slot0.autoSkip2IDKey)

			slot0.autoSkip2IDKey = nil
		end

		FightNavModule.quitFight(slot0.resultVO ~= nil and slot0.resultVO.result or FightConst.RESULT_WIN)

		if OutCardMgr.hasServant() then
			OutCardModule.addCloseCallback(function ()
				FightNavModule.quitFightCallback(uv0)
			end)
			OutCardModule.preloadThenOpenPanel()
			printLxf("openCard")
		end

		if WindowsManager.getTopPanel() then
			AudioManager.playBgmByOpenPanel(slot3:getBgmKeyName())
		end

		if CopyUtil.getCopyType(CopyMgr.nowCopyId) == CopyConst.TYPE_MAIN then
			CopyMgr.clearBarrierExtraStar(slot0.fightCopyID)
		end

		if not slot2 then
			Dispatcher.dispatch(ModuleCommand.ON_CLOSE_COPY_REWARD_PANEL)
		end

		slot0.resultVO = nil

		slot0.buffView:setActive(false)
	end
end
