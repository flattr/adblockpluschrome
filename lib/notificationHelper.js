/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

/** @module notificationHelper */

"use strict";

const {startIconAnimation, stopIconAnimation} = require("./icon");
const info = require("info");
const {Utils} = require("./utils");
const {port} = require("messaging");
const {Prefs} = require("./prefs");
const {Notification: NotificationStorage} =
  require("../adblockpluscore/lib/notification");
const {initAntiAdblockNotification} =
  require("../adblockplusui/lib/antiadblockInit");
const {initDay1Notification} = require("../adblockplusui/lib/day1Init");
const {showOptions} = require("./options");

const displayMethods = new Map([
  ["critical", ["icon", "notification", "popup"]],
  ["question", ["notification"]],
  ["normal", ["notification"]],
  ["relentless", ["notification"]],
  ["information", ["icon", "popup"]]
]);
const defaultDisplayMethods = ["popup"];

// We must hard code any "abp:" prefixed notification links here, otherwise
// notifications linking to them will not be displayed at all.
const localNotificationPages = new Map([
  ["abp:day1", "/day1.html"]
]);

// The active notification is (if any) the most recent currently displayed
// notification. Once a notification is clicked or is superceeded by another
// notification we no longer consider it active.
let activeNotification = null;

// We animate the ABP icon while some kinds of notifications are active, to help
// catch the user's attention.
let notificationIconAnimationPlaying = false;

// When a notification button is clicked we need to look up what should happen.
// This can be both for the active notification, and also for notifications
// stashed in the notification center.
let buttonsByNotificationId = new Map();

// Newer versions of Microsoft Edge (EdgeHTML 17) have the notifications
// API, but the entire browser crashes when it is used!
// https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/20146233/
const browserNotificationsSupported = require("info").platform != "edgehtml";

// Opera < 57 and Firefox (tested up to 68.0.1) do not support notifications
// being created with buttons. Opera added button support with >= 57, however
// the button click handlers have broken with >= 60 (tested up to 62). Until
// Opera fixes that bug (reference DNAWIZ-70332) we unfortunately can't use
// feature detection when deciding if notification buttons should be displayed.
const browserNotificationButtonsSupported = browserNotificationsSupported &&
                                            info.platform == "chromium" &&
                                            info.application != "opera";

// As of August 2019, only Chrome supports this flag and, since Firefox
// throws on unsupported options (tested with version 69), we need to
// explicitly set it only for supported browsers.
const browserNotificationRequireInteractionSupported = (
  info.platform == "chromium" && parseInt(info.platformVersion, 10) >= 50
);

function playNotificationIconAnimation(notification)
{
  let animateIcon = !(notification.urlFilters instanceof Array) &&
      shouldDisplay("icon", notification.type);
  if (animateIcon)
  {
    startIconAnimation(notification.type);
    notificationIconAnimationPlaying = true;
  }
}

function getNotificationButtons({type: notificationType, links}, message)
{
  let buttons = [];
  if (notificationType == "question")
  {
    buttons.push({
      type: "question",
      title: browser.i18n.getMessage("overlay_notification_button_yes")
    });
    buttons.push({
      type: "question",
      title: browser.i18n.getMessage("overlay_notification_button_no")
    });
  }
  else
  {
    let linkCount = 0;
    let regex = /<a>(.*?)<\/a>/g;
    let match;
    while (match = regex.exec(message))
    {
      buttons.push({
        type: "link",
        title: match[1],
        link: links[linkCount++]
      });
    }

    // We allow the user to disable non-essential notifications, and we add a
    // button to those notifications to make that easier to do.
    let addConfigureButton = isOptional(notificationType);

    // Chrome only allows two notification buttons so we need to fall back
    // to a single button to open all links if there are more than two.
    let maxButtons = addConfigureButton ? 1 : 2;
    if (buttons.length > maxButtons)
    {
      buttons = [
        {
          type: "open-all",
          title: browser.i18n.getMessage("notification_open_all"),
          links
        }
      ];
    }
    if (addConfigureButton)
    {
      buttons.push({
        type: "configure",
        title: browser.i18n.getMessage("notification_configure")
      });
    }
  }

  return buttons;
}

function openNotificationLink(link)
{
  let url;

  if (link.startsWith("abp:"))
    url = localNotificationPages.get(link);
  else
    url = Utils.getDocLink(link);

  browser.tabs.create({url});
}

function getButtonLinks(buttons)
{
  let links = [];

  for (let button of buttons)
  {
    if (button.type == "link" && button.link)
      links.push(button.link);
    else if (button.type == "open-all" && button.links)
      links = links.concat(button.links);
  }
  return links;
}

function openNotificationLinks(notificationId)
{
  let buttons = buttonsByNotificationId.get(notificationId) || [];
  for (let link of getButtonLinks(buttons))
    openNotificationLink(link);
}

function notificationButtonClick(notificationId, buttonIndex)
{
  let buttons = buttonsByNotificationId.get(notificationId);

  if (!(buttons && buttonIndex in buttons))
    return;

  let button = buttons[buttonIndex];

  switch (button.type)
  {
    case "link":
      openNotificationLink(button.link);
      break;
    case "open-all":
      openNotificationLinks(notificationId);
      break;
    case "configure":
      showOptions().then(([tab, optionsPort]) =>
      {
        optionsPort.postMessage({
          type: "app.respond",
          action: "focusSection",
          args: ["notifications"]
        });
      });
      break;
    case "question":
      NotificationStorage.triggerQuestionListeners(notificationId,
                                                   buttonIndex == 0);
      NotificationStorage.markAsShown(notificationId);
      break;
  }
}

/**
 * Tidy up after a notification has been dismissed.
 *
 * @param {string} notificationId
 * @param {bool} stashedInNotificationCenter
 *   If the given notification is (or might be) stashed in the notification
 *   center, we must take care to remember what its buttons do. Leave as true
 *   unless you're sure!
 */
function notificationDismissed(notificationId, stashedInNotificationCenter)
{
  if (activeNotification && activeNotification.id == notificationId)
  {
    activeNotification = null;

    if (notificationIconAnimationPlaying)
    {
      stopIconAnimation();
      notificationIconAnimationPlaying = false;
    }
  }

  if (!stashedInNotificationCenter)
    buttonsByNotificationId.delete(notificationId);
}

function showNotification(notification)
{
  if (activeNotification && activeNotification.id == notification.id)
    return;

  // Without buttons, showing notifications of the type "question" is pointless.
  if (notification.type == "question" && !browserNotificationButtonsSupported)
    return;

  let texts = NotificationStorage.getLocalizedTexts(notification);
  let buttons = getNotificationButtons(notification, texts.message);

  // Don't display notifications at all if they contain a link to a local
  // notification page which we don't have.
  for (let link of getButtonLinks(buttons))
  {
    if (link.startsWith("abp:") && !localNotificationPages.has(link))
      return;
  }

  // We take a note of the notification's buttons even if notification buttons
  // are not supported by this browser. That way, if the user clicks the
  // (buttonless) notification we can still open all the links.
  buttonsByNotificationId.set(notification.id, buttons);

  activeNotification = notification;
  if (shouldDisplay("notification", notification.type))
  {
    let notificationTitle = texts.title || "";
    let message = (texts.message || "").replace(/<\/?(a|strong)>/g, "");
    let iconUrl = browser.extension.getURL("icons/detailed/blockera-128.png");

    if (browserNotificationsSupported)
    {
      let notificationOptions = {
        type: "basic",
        title: notificationTitle,
        iconUrl,
        message,
        // We use the highest priority to prevent the notification
        // from closing automatically, for browsers that don't support the
        // requireInteraction flag.
        priority: 2
      };

      if (browserNotificationButtonsSupported)
        notificationOptions.buttons = buttons.map(({title}) => ({title}));

      if (browserNotificationRequireInteractionSupported)
        notificationOptions.requireInteraction = true;

      browser.notifications.create(notification.id, notificationOptions);
    }
    else
    {
      let linkCount = (notification.links || []).length;

      if (linkCount > 0)
      {
        message += " " + browser.i18n.getMessage(
          "notification_without_buttons"
        );
      }

      let basicNotification = new Notification(
        notificationTitle,
        {
          lang: Utils.appLocale,
          dir: Utils.readingDirection,
          body: message,
          icon: iconUrl
        }
      );

      basicNotification.addEventListener("click", () =>
      {
        openNotificationLinks(notification.id);
        notificationDismissed(notification.id, false);
      });
      basicNotification.addEventListener("close", () =>
      {
        // We'll have to assume the notification was dismissed by the user since
        // this event doesn't tell us!
        notificationDismissed(notification.id, true);
      });
    }
  }

  playNotificationIconAnimation(notification);

  if (notification.type != "question")
    NotificationStorage.markAsShown(notification.id);
}

/**
 * Initializes the notification system.
 *
 * @param {bool} firstRun
 */
exports.initNotifications = firstRun =>
{
  if (typeof Prefs.notificationdata.firstVersion == "undefined")
    Prefs.notificationdata.firstVersion = "0";

  if (browserNotificationsSupported)
  {
    let onClick = (notificationId, buttonIndex) =>
    {
      if (typeof buttonIndex == "number")
        notificationButtonClick(notificationId, buttonIndex);
      else if (!browserNotificationButtonsSupported)
        openNotificationLinks(notificationId);

      // Chrome hides notifications in the notification center when clicked,
      // so we need to clear them.
      browser.notifications.clear(notificationId);

      // But onClosed isn't triggered when we clear the notification, so we need
      // to take care to clear our record of it here too.
      notificationDismissed(notificationId, false);
    };
    browser.notifications.onButtonClicked.addListener(onClick);
    browser.notifications.onClicked.addListener(onClick);

    let onClosed = (notificationId, byUser) =>
    {
      // Despite using the highest priority for our notifications, Windows 10
      // will still hide them after a few seconds and stash them in the
      // notification center. We still consider the notification active when
      // this happens, in order to continue animating the ABP icon and/or
      // displaying the notification details in our popup window.
      // Note: Even if the notification was closed by the user, it still might
      //       be stashed in the notification center.
      if (byUser)
        notificationDismissed(notificationId, true);
    };
    browser.notifications.onClosed.addListener(onClosed);
  }

  initAntiAdblockNotification();

  if (firstRun)
    initDay1Notification();
};

/**
 * Returns the currently active notification (if any).
 *
 * @return {?object}
 */
exports.getActiveNotification = () => activeNotification;

let shouldDisplay =
/**
 * Determines whether a given display method should be used for a
 * specified notification type.
 *
 * @param {string} method Display method: icon, notification or popup
 * @param {string} notificationType
 * @return {boolean}
 */
exports.shouldDisplay = (method, notificationType) =>
{
  let methods = displayMethods.get(notificationType) || defaultDisplayMethods;
  return methods.includes(method);
};

let isOptional =
/**
 * If the given notification type is of vital importance return false,
 * true otherwise.
 *
 * @param {string} notificationType
 * @return {boolean}
 */
exports.isOptional = notificationType =>
{
  return !["critical", "relentless"].includes(notificationType);
};

port.on("notifications.clicked", (message, sender) =>
{
  if (message.link)
  {
    openNotificationLink(message.link);
  }
  // While clicking on a desktop notification's button dismisses the
  // notification, clicking on a popup window notification's link does not.
  else
  {
    if (browserNotificationsSupported)
      browser.notifications.clear(message.id);

    notificationDismissed(message.id, true);
  }
});

ext.pages.onLoading.addListener(page =>
{
  NotificationStorage.showNext(page.url.href);
});

Prefs.on("blocked_total", () =>
{
  NotificationStorage.showNext();
});

NotificationStorage.addShowListener(showNotification);
