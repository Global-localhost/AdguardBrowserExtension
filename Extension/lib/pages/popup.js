/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Adguard Browser Extension.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global $, PopupController */
var backgroundPage = adguard.backgroundPage.getWindow();
var antiBannerService = backgroundPage.antiBannerService;
var UI = backgroundPage.UI;
var uiService = backgroundPage.uiService;
var framesMap = backgroundPage.framesMap;
var filteringLog = backgroundPage.filteringLog;
var Prefs = backgroundPage.Prefs;
var Utils = backgroundPage.Utils;

// http://jira.performix.ru/browse/AG-3474
var resizePopupWindowForMacOs = function ($) {
    if (Utils.isSafariBrowser() || Utils.isFirefoxBrowser() || !Utils.isMacOs()) {
        return;
    }
    setTimeout(function () {
        var block = $(".macoshackresize");
        block.css("padding-top", "23px");
    }, 1000);
};

// Make global for popup-script.js (Safari Code)
var controller;
var tab;

//make global for other popup scripts;
$(document).ready(function () {

    adguard.tabs.getActive(function (t) {

        tab = t;

        var tabInfo = framesMap.getFrameInfo(tab);
        var filteringInfo = filteringLog.getTabInfo(tab);

        controller = new PopupController({
            platform: Prefs.platform,
            showStatsSupported: !Utils.isContentBlockerEnabled()
        });

        //override
        controller.afterRender = function () {
            //add some delay for show popup size properly
            setTimeout(function () {
                controller.resizePopupWindow();
            }, 10);
            resizePopupWindowForMacOs($);
        };
        controller.resizePopup = function (width, height) {
            adguard.resizePopup(width, height);
        };
        //popup checkbox actions
        controller.addWhiteListDomain = function () {
            uiService.whiteListTab(tab);
            if (tabInfo.adguardDetected) {
                adguard.closePopup();
            }
        };
        controller.removeWhiteListDomain = function () {
            uiService.unWhiteListTab(tab);
            if (tabInfo.adguardDetected) {
                adguard.closePopup();
            }
        };
        controller.changeApplicationFilteringDisabled = function (disabled) {
            uiService.changeApplicationFilteringDisabled(disabled);
        };
        //popup menu actions
        controller.openSiteReportTab = function (url) {
            uiService.openSiteReportTab(url);
            adguard.closePopup();
        };
        controller.openSettingsTab = function () {
            uiService.openSettingsTab();
            adguard.closePopup();
        };
        controller.openAssistantInTab = function () {
            uiService.openAssistant();
            adguard.closePopup();
        };
        controller.openLink = function (url) {
            UI.openTab(url);
            adguard.closePopup();
        };
        controller.openFilteringLog = function (tabId) {
            uiService.openFilteringLog(tabId);
            adguard.closePopup();
        };
        controller.resetBlockedAdsCount = function () {
            framesMap.resetBlockedAdsCount();
        };
        controller.sendFeedback = function (url, topic, comment) {
            antiBannerService.sendFeedback(url, topic, comment);
        };

        //render popup
        controller.render(tabInfo, filteringInfo);
    });
});