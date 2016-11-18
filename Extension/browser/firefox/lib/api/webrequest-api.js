/* global XPCOMUtils, Services, Cc, Ci, Cr, Cm, components */
/* global Map, unload, RequestTypes, Log, Utils, EventChannels, adguardApplication */

(function () {

    adguard.webRequest = (function () {

        function noOpFunc() {
        }

        var onBeforeRequestChannel = EventChannels.newChannel();
        var onBeforeSendHeadersChannel = EventChannels.newChannel();
        var onHeadersReceivedChannel = EventChannels.newChannel();

        // https://developer.mozilla.org/ja/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIContentPolicy#Constants
        var ContentTypes = {
            TYPE_OTHER: 1,
            TYPE_SCRIPT: 2,
            TYPE_IMAGE: 3,
            TYPE_STYLESHEET: 4,
            TYPE_OBJECT: 5,
            TYPE_DOCUMENT: 6,
            TYPE_SUBDOCUMENT: 7,
            TYPE_REFRESH: 8,
            TYPE_XBL: 9,
            TYPE_PING: 10,
            TYPE_XMLHTTPREQUEST: 11,
            TYPE_OBJECT_SUBREQUEST: 12,
            TYPE_DTD: 13,
            TYPE_FONT: 14,
            TYPE_MEDIA: 15,
            TYPE_WEBSOCKET: 16
        };

        /**
         * Gets request type string representation
         *
         * @param contentType   Request content type
         * @param uriPath       Request URI path
         */
        function getRequestType(contentType, uriPath) {
            switch (contentType) {
                case ContentTypes.TYPE_DOCUMENT:
                    return RequestTypes.DOCUMENT;
                case ContentTypes.TYPE_SCRIPT:
                    return RequestTypes.SCRIPT;
                case ContentTypes.TYPE_IMAGE:
                    return RequestTypes.IMAGE;
                case ContentTypes.TYPE_STYLESHEET:
                    return RequestTypes.STYLESHEET;
                case ContentTypes.TYPE_OBJECT:
                    return RequestTypes.OBJECT;
                case ContentTypes.TYPE_SUBDOCUMENT:
                    return RequestTypes.SUBDOCUMENT;
                case ContentTypes.TYPE_XMLHTTPREQUEST:
                    return RequestTypes.XMLHTTPREQUEST;
                case ContentTypes.TYPE_OBJECT_SUBREQUEST:
                    return RequestTypes.OBJECT_SUBREQUEST;
                case ContentTypes.TYPE_FONT:
                    return RequestTypes.FONT;
                case ContentTypes.TYPE_MEDIA:
                    return RequestTypes.MEDIA;
                case ContentTypes.TYPE_WEBSOCKET:
                    return RequestTypes.WEBSOCKET;
                default:
                    return Utils.parseContentTypeFromUrlPath(uriPath) || RequestTypes.OTHER;
            }
        }

        function getRequestHeaders(request) {
            var requestHeaders = [];
            request.visitRequestHeaders(function (header, value) {
                requestHeaders.push({name: header, value: value});
            });
            return requestHeaders;
        }

        function getResponseHeaders(request) {
            var responseHeaders = [];
            request.visitResponseHeaders(function (header, value) {
                responseHeaders.push({name: header, value: value});
            });
            return responseHeaders;
        }

        /**
         * Gets load context from given nsIChannel
         * @param channel nsIChannel implementation
         * @private
         */
        function getChannelLoadContext(channel) {
            var loadContext;
            try {
                loadContext = channel.notificationCallbacks.getInterface(Ci.nsILoadContext);
            } catch (e) {
            }
            if (!loadContext) {
                try {
                    loadContext = channel.loadGroup.notificationCallbacks.getInterface(Ci.nsILoadContext);
                } catch (e) {
                    // Lots of requests have no notificationCallbacks, mostly background
                    // ones like OCSP checks or smart browsing fetches.
                    Log.debug("_getLoadContext: no loadContext for " + channel.URI.spec);
                    return null;
                }
            }

            return loadContext;
        }

        /**
         * Gets XUL browser for given nsIChannel.
         *
         * We've used a method from HTTPS Everywhere to fix e10s incompatibility:
         * https://github.com/pde/https-everywhere/blob/1afa2d65874403c7c89ce8af320bbd79b0827823/src/components/https-everywhere.js
         *
         * Returns an instance of https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XUL/browser.
         * Also returns DOMWindow, tab and contentWindow if possible.
         *
         * @param channel nsIChannel implementation
         * @returns {*}
         */
        function getChannelContextData(channel) {

            var topFrameElement, associatedWindow;
            var spec = channel.URI.spec;
            var loadContext = getChannelLoadContext(channel);

            if (loadContext) {
                topFrameElement = loadContext.topFrameElement;
                try {
                    // If loadContext is an nsDocShell, associatedWindow is present.
                    // Otherwise, if it's just a LoadContext, accessing it will throw
                    // NS_ERROR_UNEXPECTED.
                    associatedWindow = loadContext.associatedWindow;
                } catch (e) {
                    // Ignore
                }
            }

            // On e10s (multiprocess, aka electrolysis) Firefox,
            // loadContext.topFrameElement gives us a reference to the XUL <browser>
            // element we need. However, on non-e10s Firefox, topFrameElement is null.

            // More details here:
            // https://bugzilla.mozilla.org/show_bug.cgi?id=1113294
            // https://developer.mozilla.org/en-US/Firefox/Multiprocess_Firefox/Limitations_of_chrome_scripts#HTTP_requests
            if (topFrameElement) {
                return {
                    browser: topFrameElement
                };
            } else if (associatedWindow) {
                // For non-e10s Firefox, get the XUL <browser> element using this rather
                // magical / opaque code cribbed from
                // https://developer.mozilla.org/en-US/Add-ons/Code_snippets/Tabbed_browser#Getting_the_browser_that_fires_the_http-on-modify-request_notification_(example_code_updated_for_loadContext)

                // this is the HTML DOM window of the page that just loaded
                var contentWindow = loadContext.associatedWindow;
                // aDOMWindow this is the firefox window holding the tab
                var aDOMWindow = contentWindow.top.QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIWebNavigation)
                    .QueryInterface(Ci.nsIDocShellTreeItem)
                    .rootTreeItem
                    .QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIDOMWindow);
                // this is the gBrowser object of the firefox window this tab is in
                var gBrowser = aDOMWindow.gBrowser;
                if (gBrowser && gBrowser._getTabForContentWindow) {
                    var aTab = gBrowser._getTabForContentWindow(contentWindow.top);

                    // this is the clickable tab xul element, the one found in the tab strip
                    // of the firefox window, aTab.linkedBrowser is same as browser var above
                    // this is the browser within the tab
                    if (aTab) {
                        return {
                            tab: aTab,
                            browser: aTab.linkedBrowser,
                            DOMWindow: aDOMWindow,
                            contentWindow: contentWindow
                        };
                    } else {
                        Log.debug("getChannelContextData: aTab was null for " + spec);
                        return null;
                    }
                } else if (aDOMWindow.BrowserApp) {

                    // gBrowser is unavailable in Firefox for Android, and in some desktop
                    // contexts, like the fetches for new tab tiles (which have an
                    // associatedWindow, but no gBrowser)?
                    // If available, try using the BrowserApp API:
                    // https://developer.mozilla.org/en-US/Add-ons/Firefox_for_Android/API/BrowserApp
                    // TODO: We don't get the toolbar icon on android. Probably need to fix the gBrowser reference in toolbar_button.js.
                    // Also TODO: Where are these log messages going? They don't show up in remote debug console.
                    var mTab = aDOMWindow.BrowserApp.getTabForWindow(contentWindow.top);
                    if (mTab) {
                        return {
                            tab: mTab,
                            browser: mTab.browser,
                            DOMWindow: aDOMWindow,
                            contentWindow: contentWindow
                        };
                    } else {
                        Log.error("getChannelContextData: mTab was null for " + spec);
                        return null;
                    }
                } else {
                    Log.error("getChannelContextData: No gBrowser and no BrowserApp for " + spec);
                    return null;
                }
            } else {
                Log.debug("getChannelContextData: No loadContext for " + spec);
                return null;
            }
        }

        function getTabIdForChannel(channel) {

            var contextData = getChannelContextData(channel);

            if (contextData && contextData.tab) {
                return adguard.tabsImpl.getTabIdForTab(contextData.tab);
            }

            if (contextData && contextData.browser) {
                var browser = contextData.browser;
                var xulTab = adguard.tabsImpl.getTabForBrowser(browser);

                // getTabForBrowser() returns null for FF 38 ESR
                if (!xulTab) {
                    // TODO: temporary fix
                    // If browser.docShell returns null then browser.contentWindow throws exception: this.docShell is null
                    if (browser.docShell && browser.contentWindow) {
                        xulTab = adguard.tabsImpl.getTabForContentWindow(browser.contentWindow);
                    }
                    if (!xulTab) {
                        return null;
                    }
                }

                return adguard.tabsImpl.getTabIdForTab(xulTab);
            }
            return null;
        }

        var RequestsDetailsStorage = (function () {

            function RequestDetails() {
                this.frameId = 0;
                this.parentFrameId = 0;
                this.type = 0;
                this.tabId = 0;
                this._key = ''; // key is url, from URI.spec
            }

            var detailsURLToIndex = new Map();
            var detailsWritePointer = 0;
            var detailsRingBuffer = new Array(256);

            var i = detailsRingBuffer.length;
            while (i--) {
                detailsRingBuffer[i] = new RequestDetails();
            }

            var create = function (url) {
                var bucket;
                var i = detailsWritePointer;
                detailsWritePointer = i + 1 & 255; // jshint ignore:line
                var details = detailsRingBuffer[i];
                var si = String.fromCharCode(i);
                // Cleanup unserviced pending request
                if (details._key !== '') {
                    bucket = detailsURLToIndex.get(details._key);
                    if (bucket.length === 1) {
                        detailsURLToIndex.delete(details._key);
                    } else {
                        var pos = bucket.indexOf(si);
                        detailsURLToIndex.set(details._key, bucket.slice(0, pos) + bucket.slice(pos + 1));
                    }
                }
                bucket = detailsURLToIndex.get(url);
                detailsURLToIndex.set(url, bucket === undefined ? si : si + bucket);
                details._key = url;
                return details;
            };

            var get = function (url) {
                var bucket = detailsURLToIndex.get(url);
                if (bucket === undefined) {
                    return null;
                }
                var i = bucket.charCodeAt(0);
                if (bucket.length === 1) {
                    detailsURLToIndex.delete(url);
                } else {
                    detailsURLToIndex.set(url, bucket.slice(1));
                }
                var details = detailsRingBuffer[i];
                details._key = ''; // mark as "serviced"
                return details;
            };

            return {
                create: create,
                get: get
            };

        })();

        /**
         * This objects manages HTTP requests filtering.
         *
         * It implements nsIContentPolicy and so it can block requests.
         * It also subscribes to the following events:
         * http-on-examine-response, http-on-examine-cached-response, http-on-examine-merged-response, http-on-opening-request
         */
        var WebRequestImpl = { // jshint ignore:line

            classDescription: 'Adguard net-channel-event-sinks',
            classID: components.ID('32dfeb6f-1ad5-4062-a380-a41ecd8b89b0'),
            contractID: '@adguard.com/adg/net-channel-event-sinks;1',

            REQUEST_DETAILS_PROP: 'request-details-property',

            EMPTY_DETAILS: {
                tabId: '',
                frameId: 0,
                parentFrameId: -1,
                type: ContentTypes.TYPE_OTHER
            },

            get componentRegistrar() {
                return Cm.QueryInterface(Ci.nsIComponentRegistrar);
            },

            get categoryManager() {
                return Cc['@mozilla.org/categorymanager;1'].getService(Ci.nsICategoryManager);
            },

            QueryInterface: XPCOMUtils.generateQI([Ci.nsIFactory, Ci.nsIObserver, Ci.nsIChannelEventSink, Ci.nsISupportsWeakReference]),

            createInstance: function (outer, iid) {
                if (outer) {
                    throw Cr.NS_ERROR_NO_AGGREGATION;
                }
                return this.QueryInterface(iid);
            },

            /**
             * Initialize WebRequest filtering, register is as events listener
             */
            init: function () {

                Log.info('Adguard addon: Initializing webRequest...');

                this.observe = this.observe.bind(this);

                Services.obs.addObserver(this, 'http-on-examine-response', true);
                Services.obs.addObserver(this, 'http-on-examine-cached-response', true);
                Services.obs.addObserver(this, 'http-on-examine-merged-response', true);
                Services.obs.addObserver(this, 'http-on-modify-request', true);

                if (this.componentRegistrar.isCIDRegistered(this.classID)) {
                    try {
                        this.componentRegistrar.unregisterFactory(this.classID, Cm.getClassObject(this.classID, Ci.nsIFactory));
                    } catch (ex) {
                        Log.error('Unable to unregister instance {0}, cause: {1}', this.classID, ex);
                    }
                }

                this.componentRegistrar.registerFactory(
                    this.classID,
                    this.classDescription,
                    this.contractID,
                    this
                );
                this.categoryManager.addCategoryEntry(
                    'net-channel-event-sinks',
                    this.contractID,
                    this.contractID,
                    false,
                    true
                );

                unload.when(this.unregister.bind(this));
            },

            unregister: function () {

                Services.obs.removeObserver(this, 'http-on-examine-response');
                Services.obs.removeObserver(this, 'http-on-examine-cached-response');
                Services.obs.removeObserver(this, 'http-on-examine-merged-response');
                Services.obs.removeObserver(this, 'http-on-modify-request');

                this.componentRegistrar.unregisterFactory(this.classID, this);
                this.categoryManager.deleteCategoryEntry(
                    'net-channel-event-sinks',
                    this.contractID,
                    false
                );
            },

            saveRequestDetails: function (tabId, details) {
                var requestDetails = RequestsDetailsStorage.create(details.url);
                requestDetails.frameId = details.frameId;
                requestDetails.parentFrameId = details.parentFrameId;
                requestDetails.type = details.type;
                requestDetails.tabId = tabId;
            },

            /**
             * nsIChannelEventSink interface implementation
             *
             * @param oldChannel
             * @param newChannel
             * @param flags
             * @param callback
             */
            asyncOnChannelRedirect: function (oldChannel, newChannel, flags, callback) {
                try {
                    var URI = newChannel.URI;
                    if (!URI.schemeIs('http') && !URI.schemeIs('https')) {
                        return;
                    }

                    if (oldChannel instanceof Ci.nsIPropertyBag === false || newChannel instanceof Ci.nsIWritablePropertyBag === false) {
                        return;
                    }

                    // Just copy properties for further handling
                    var property = oldChannel.getProperty(this.REQUEST_DETAILS_PROP);
                    if (property) {
                        newChannel.setProperty(this.REQUEST_DETAILS_PROP, property);
                    }
                } catch (ex) {
                    // Don't throw exception further
                    Log.error('asyncOnChannelRedirect: Error while processing redirect from {0} to {1}: {2}', oldChannel.URI.spec, newChannel.URI.spec, ex);
                } finally {
                    callback.onRedirectVerifyCallback(Cr.NS_OK);
                }
            },

            /**
             * nsIObserver interface implementation.
             * Learn more here:
             * https://developer.mozilla.org/en-US/Add-ons/Overlay_Extensions/XUL_School/Intercepting_Page_Loads#HTTP_Observers
             *
             * @param channel - http channel
             * @param type - event type
             */
            observe: function (channel, type) {
                if (!(channel instanceof Ci.nsIHttpChannel)) {
                    return;
                }
                try {
                    switch (type) {
                        case 'http-on-modify-request':
                            this._httpOnModifyRequest(channel);
                            break;
                        case 'http-on-examine-response':
                        case 'http-on-examine-cached-response':
                        case 'http-on-examine-merged-response':
                            this._httpOnExamineResponse(channel);
                            break;
                    }
                } catch (ex) {
                    // Don't throw exception further
                    Log.error('observe: Error while handling event: {0}', ex);
                }
            },

            getDetailsFromChannel: function (channel) {
                if (channel instanceof Ci.nsIPropertyBag) {
                    try {
                        return channel.getProperty(this.REQUEST_DETAILS_PROP) || null;
                    } catch (ex) {
                    }
                }
                return null;
            },

            convertToRequest: function (URI, details) {

                var frameId = 0;        // Id of this frame (only for main_frame and sub_frame types)
                var requestFrameId = 0; // Id of frame where request is executed

                switch (details.type) {
                    case ContentTypes.TYPE_DOCUMENT:
                        frameId = 0;
                        break;
                    case ContentTypes.TYPE_SUBDOCUMENT:
                        frameId = details.frameId;
                        requestFrameId = details.parentFrameId; // For sub_frame use parentFrameId as id of frame that wraps this frame
                        break;
                    default:
                        requestFrameId = details.frameId;
                        break;
                }

                // Relate request to main_frame
                if (requestFrameId === -1) {
                    requestFrameId = 0;
                }

                return {
                    requestUrl: URI.asciiSpec,
                    tab: {tabId: details.tabId},
                    requestType: getRequestType(details.type, URI.path),
                    frameId: frameId,
                    requestFrameId: requestFrameId
                };
            },

            handleRequest: function (channel, details) {

                var request = this.convertToRequest(channel.URI, details);

                var skip = onBeforeRequestChannel.notify(request);
                if (skip === false) {
                    channel.cancel(Cr.NS_BINDING_ABORTED);
                    return true;
                }

                this.processOnBeforeSendHeaders(channel, request);

                return false;
            },

            _httpOnModifyRequest: function (channel) {

                var details = this.getDetailsFromChannel(channel);
                if (details !== null) {
                    this.handleRequest(channel, details);
                    return;
                }

                details = RequestsDetailsStorage.get(channel.URI.asciiSpec);

                var type = ContentTypes.TYPE_OTHER;
                var frameId = 0;
                var parentFrameId = 0;

                var loadInfo = channel.loadInfo;
                if (loadInfo) {
                    type = loadInfo.externalContentPolicyType !== undefined ? loadInfo.externalContentPolicyType : loadInfo.contentPolicyType;
                    if (!type) {
                        type = ContentTypes.TYPE_OTHER;
                    }
                }

                if (details) {
                    if (type !== ContentTypes.TYPE_OTHER) {
                        details.type = type;
                    }
                    if (details.type === ContentTypes.TYPE_DOCUMENT) {
                        var tabId = getTabIdForChannel(channel);
                        if (tabId) {
                            details.tabId = tabId;
                        }
                    }
                } else {
                    // No matching pending request found, synthetize one.
                    details = this.EMPTY_DETAILS;
                    details.tabId = getTabIdForChannel(channel);
                    details.frameId = frameId;
                    details.parentFrameId = parentFrameId;
                    details.type = type;
                }

                if (this.handleRequest(channel, details)) {
                    return;
                }

                // If request is not handled we may use the data in on-modify-request
                if (channel instanceof Ci.nsIWritablePropertyBag) {
                    channel.setProperty(this.REQUEST_DETAILS_PROP, details);
                }
            },

            /**
             * Handler for http-on-examine-response and such.
             *
             * @param channel nsIHttpChannel
             * @private
             */
            _httpOnExamineResponse: function (channel) {

                var details = this.getDetailsFromChannel(channel);

                // Get content type
                var isDocument = (channel.loadFlags & channel.LOAD_DOCUMENT_URI); // jshint ignore:line
                var type = !!details ? details.type : null;

                if (!type && isDocument) {
                    type = ContentTypes.TYPE_DOCUMENT;
                } else if (!type) {
                    type = ContentTypes.TYPE_OTHER;
                }

                var request;

                // Call onBeforeRequest for main frame again
                if (type === ContentTypes.TYPE_DOCUMENT) {

                    if (!details) {
                        details = {
                            frameId: 0,
                            parentFrameId: -1,
                            type: type
                        };
                    }
                    details.tabId = getTabIdForChannel(channel);

                    request = this.convertToRequest(channel.URI, details);
                    onBeforeRequestChannel.notify(request);
                    this.processOnHeadersReceived(channel, request);
                    return;
                }

                if (!details) {
                    return;
                }

                request = this.convertToRequest(channel.URI, details);
                this.processOnHeadersReceived(channel, request);
            },

            processOnBeforeSendHeaders: function (channel, request) {

                request.requestHeaders = getRequestHeaders(channel);

                var result = onBeforeSendHeadersChannel.notify(request);

                // TODO: can we move it to webrequest.js?
                // Set authorization headers for requests to desktop AG
                if (adguardApplication.isIntegrationRequest(request.requestUrl)) {
                    var authHeaders = adguardApplication.getAuthorizationHeaders();
                    for (var i = 0; i < authHeaders.length; i++) {
                        channel.setRequestHeader(authHeaders[i].headerName, authHeaders[i].headerValue, false);
                    }
                }

                if (!result) {
                    return;
                }

                var modifiedHeaders = result.modifiedHeaders;
                if (modifiedHeaders) {
                    for (var j = 0; j < modifiedHeaders.length; j++) {
                        var header = modifiedHeaders[j];
                        channel.setRequestHeader(header.name, header.value, false);
                    }
                }
            },

            processOnHeadersReceived: function (channel, request) {

                request.responseHeaders = getResponseHeaders(channel);

                var result = onHeadersReceivedChannel.notify(request);

                if (!result) {
                    return;
                }

                var modifiedHeaders = result.modifiedHeaders;
                if (modifiedHeaders) {
                    for (var i = 0; i < modifiedHeaders.length; i++) {
                        var header = modifiedHeaders[i];
                        channel.setResponseHeader(header.name, header.value, true);
                    }
                }
            }
        };

        var saveRequestDetails = function (tabId, details) {
            WebRequestImpl.saveRequestDetails(tabId, details);
        };

        WebRequestImpl.init();

        return {

            saveRequestDetails: saveRequestDetails,

            onBeforeRequest: onBeforeRequestChannel,
            onBeforeSendHeaders: onBeforeSendHeadersChannel,
            onHeadersReceived: onHeadersReceivedChannel,
            handlerBehaviorChanged: noOpFunc
        };

    })();

    adguard.webNavigation = (function () {

        var onCreatedNavigationTargetChannel = EventChannels.newChannel();

        var onPopupCreated = function (tabId, targetUrl, sourceUrl) {

            var browser = null;

            // Try to find source tab
            var browsers = adguard.tabsImpl.browsers();
            for (var i = 0; i < browsers.length; i++) {
                var br = browsers[i];
                if (br.currentURI.asciiSpec === sourceUrl) {
                    browser = br;
                    break;
                }
            }

            if (!browser) {
                return;
            }

            var sourceTab = adguard.tabsImpl.getTabForBrowser(browser);
            if (!sourceTab) {
                return;
            }
            var sourceTabId = adguard.tabsImpl.getTabIdForTab(sourceTab);

            if (tabId !== sourceTabId) {
                onCreatedNavigationTargetChannel.notify({
                    tabId: tabId,
                    url: targetUrl,
                    sourceTabId: sourceTabId
                });
            }
        };

        return {

            onPopupCreated: onPopupCreated,

            onCreatedNavigationTarget: onCreatedNavigationTargetChannel
        };

    })();

})(window);