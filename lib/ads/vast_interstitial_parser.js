/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


goog.provide('shaka.ads.VastInterstitialParser');

goog.require('shaka.ads.InterstitialTracker');
goog.require('shaka.ads.Utils');
goog.require('shaka.device.DeviceFactory');
goog.require('shaka.media.ManifestParser');
goog.require('shaka.util.Error');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.StreamUtils');
goog.require('shaka.util.TextParser');
goog.require('shaka.util.TXml');
goog.require('shaka.util.URL');


/**
 * A class responsible for parsing VAST/VMAP ad manifests into interstitials.
 */
shaka.ads.VastInterstitialParser = class {
  /**
   * @param {function(string):!Promise<shaka.extern.Response>=} request
   * @param {function(string)=} sendBeacon
   */
  constructor(request, sendBeacon = () => {}) {
    /**
     * @private
     * @const
     */
    this.request_ = request;
    /**
     * @private
     * @const
     */
    this.sendBeacon_ = sendBeacon;
  }

  /**
   * Loads a VAST or VMAP tag and resolves its references into interstitials.
   * @param {string} uri
   * @param {function():?number} getCurrentTime
   * @return {!Promise<!Array<shaka.extern.AdInterstitial>>}
   */
  async load(uri, getCurrentTime) {
    const source = await this.loadXml_(uri, 'VAST,vmap:VMAP');
    if (source.node.tagName == 'VAST') {
      return this.resolveVast_(source, getCurrentTime(), [], new Set(),
          /* allowMultipleAds= */ true, /* followWrappers= */ true);
    }
    const adBreaks = this.parseVMAP(source.node);
    const ads = await Promise.all(adBreaks.map(async (ad) => {
      const tagUri = this.resolveUri_(source.uri, ad.uri);
      const vast = await this.loadXml_(tagUri, 'VAST');
      return this.resolveVast_(vast, ad.time, [], new Set(),
          ad.allowMultipleAds, ad.followWrappers);
    }));
    return [].concat(...ads);
  }

  /**
   * @param {string} uri
   * @param {string} rootElement
   * @return {!Promise<!shaka.ads.VastInterstitialParser.Source_>}
   * @private
   */
  async loadXml_(uri, rootElement) {
    const response = await this.request_(uri);
    let node = null;
    try {
      node = shaka.util.TXml.parseXml(response.data, rootElement);
    } catch (error) {
      // Invalid XML or an encoding the parser cannot decode.
    }
    if (!node) {
      const Error = shaka.util.Error;
      throw new Error(Error.Severity.CRITICAL, Error.Category.ADS,
          Error.Code.VAST_INVALID_XML);
    }
    return {node, uri: shaka.util.URL.toAbsolute(response.uri || uri)};
  }

  /**
   * @param {!shaka.extern.xml.Node} vast
   * @param {?number} currentTime
   * @return {!Promise<!Array<shaka.extern.AdInterstitial>>}
   */
  parseVastToInterstitials(vast, currentTime) {
    return this.resolveVast_(
        {node: vast, uri: ''}, currentTime, [], new Set(), true, false);
  }

  /**
   * @param {!shaka.ads.VastInterstitialParser.Source_} source
   * @param {?number} currentTime
   * @param {!Array<!shaka.ads.VastInterstitialParser.Source_>} wrappers
   * @param {!Set<string>} visited
   * @param {boolean} allowMultipleAds
   * @param {boolean} followWrappers
   * @return {!Promise<!Array<shaka.extern.AdInterstitial>>}
   * @private
   */
  async resolveVast_(source, currentTime, wrappers, visited, allowMultipleAds,
      followWrappers) {
    const ads = shaka.util.TXml.findChildren(source.node, 'Ad').filter((ad) =>
      followWrappers || shaka.util.TXml.findChild(ad, 'InLine'));
    const sequence = (ad) =>
      shaka.util.TXml.parsePositiveInt(ad.attributes['sequence']);
    const standAlone = ads.filter((ad) => !sequence(ad));
    const pod = allowMultipleAds ? ads.filter((ad) => sequence(ad)) : [];
    pod.sort((a, b) => sequence(a) - sequence(b));
    const selected = pod.length ? pod :
        (allowMultipleAds ? standAlone : standAlone.slice(0, 1));
    if (!selected.length) {
      this.reportError_(303, [...wrappers, source]);
      return [];
    }
    const path = new Set(visited);
    if (source.uri) {
      path.add(this.withoutFragment_(source.uri));
    }
    const resolve = (ad) => this.resolveAd_(
        ad, source.uri, currentTime, wrappers, path, allowMultipleAds);
    const interstitials = [];
    let fallbackIndex = 0;
    for (const ad of selected) {
      // Keep the pod in sequence order, including any fallback ads.
      // eslint-disable-next-line no-await-in-loop
      let result = await resolve(ad);
      const wrapper = shaka.util.TXml.findChild(ad, 'Wrapper');
      const fallback = !wrapper ||
          this.parseBoolean_(wrapper.attributes['fallbackOnNoAd']);
      if (pod.length && !result.length && fallback) {
        while (!result.length && fallbackIndex < standAlone.length) {
          // eslint-disable-next-line no-await-in-loop
          result = await resolve(standAlone[fallbackIndex++]);
        }
      }
      interstitials.push(...result);
    }
    return interstitials;
  }

  /**
   * @param {!shaka.extern.xml.Node} ad
   * @param {string} baseUri
   * @param {?number} currentTime
   * @param {!Array<!shaka.ads.VastInterstitialParser.Source_>} wrappers
   * @param {!Set<string>} visited
   * @param {boolean} allowMultipleAds
   * @return {!Promise<!Array<shaka.extern.AdInterstitial>>}
   * @private
   */
  async resolveAd_(ad, baseUri, currentTime, wrappers, visited,
      allowMultipleAds) {
    const inline = shaka.util.TXml.findChild(ad, 'InLine');
    if (inline) {
      const source = {node: inline, uri: baseUri};
      const ads = await this.parseInline_(ad.attributes['id'] || null,
          source, currentTime, wrappers);
      if (!ads.length) {
        const creatives = this.getCreatives_(inline);
        const linear = creatives.some((c) =>
          shaka.util.TXml.findChild(c, 'Linear'));
        const nonLinear = creatives.some((c) =>
          shaka.util.TXml.findChild(c, 'NonLinearAds'));
        this.reportError_(linear ? 403 : (nonLinear ? 503 : 101),
            [...wrappers, source]);
      }
      return ads;
    }
    const wrapper = shaka.util.TXml.findChild(ad, 'Wrapper');
    if (!wrapper) {
      this.reportError_(101, wrappers);
      return [];
    }
    const chain = [...wrappers, {node: wrapper, uri: baseUri}];
    const tag = shaka.util.TXml.findChild(wrapper, 'VASTAdTagURI');
    const uri = tag && shaka.util.TXml.getContents(tag);
    if (!uri) {
      this.reportError_(101, chain);
      return [];
    }
    const resolvedUri = this.resolveUri_(baseUri, uri);
    const key = this.withoutFragment_(resolvedUri);
    if (chain.length > shaka.ads.VastInterstitialParser.MAX_WRAPPERS_ ||
        visited.has(key)) {
      this.reportError_(302, chain);
      return [];
    }

    let vast;
    try {
      vast = await this.loadXml_(shaka.ads.Utils.expandVastUri(resolvedUri),
          'VAST');
    } catch (error) {
      const Code = shaka.util.Error.Code;
      if (error?.code == Code.OPERATION_ABORTED) {
        throw error;
      }
      this.reportError_(error?.code == Code.VAST_INVALID_XML ? 100 : 301,
          chain);
      return [];
    }
    if (visited.has(this.withoutFragment_(vast.uri))) {
      this.reportError_(302, chain);
      return [];
    }
    const path = new Set([...visited, key]);
    const allowMultiple = allowMultipleAds &&
        this.parseBoolean_(wrapper.attributes['allowMultipleAds']);
    return this.resolveVast_(vast, currentTime, chain, path, allowMultiple,
        shaka.util.TXml.parseAttr(wrapper, 'followAdditionalWrappers',
            this.parseBoolean_) !== false);
  }

  /**
   * @param {number} code
   * @param {!Array<!shaka.ads.VastInterstitialParser.Source_>} sources
   * @private
   */
  reportError_(code, sources) {
    for (const source of sources) {
      for (const uri of this.readUris_(source.node, 'Error', source.uri)) {
        this.sendBeacon_(shaka.ads.Utils.expandVastUri(uri, {
          'ERRORCODE': String(code),
        }));
      }
    }
  }

  /**
   * @param {?string} adId
   * @param {!shaka.ads.VastInterstitialParser.Source_} inline
   * @param {?number} currentTime
   * @param {!Array<!shaka.ads.VastInterstitialParser.Source_>} wrappers
   * @return {!Promise<!Array<shaka.extern.AdInterstitial>>}
   * @private
   */
  async parseInline_(adId, inline, currentTime, wrappers) {
    /** @type {!Array<shaka.extern.AdInterstitial>} */
    const interstitials = [];
    for (const creative of this.getCreatives_(inline.node)) {
      const linear = shaka.util.TXml.findChild(creative, 'Linear');
      if (linear) {
        const {tracking, clickThroughUrl} = this.readTracking_(
            wrappers, inline, linear, null);
        this.processLinearAd_(interstitials, currentTime, linear, tracking,
            adId, inline.uri, clickThroughUrl);
      }
      const nonLinearAds = shaka.util.TXml.findChild(creative, 'NonLinearAds');
      if (!nonLinearAds) {
        continue;
      }
      const nonLinears =
          shaka.util.TXml.findChildren(nonLinearAds, 'NonLinear');
      for (const nonLinear of nonLinears) {
        // Keep interstitials in creative order.
        // eslint-disable-next-line no-await-in-loop
        const resource = await this.selectNonLinearResource_(nonLinear);
        if (resource) {
          const {tracking, clickThroughUrl} = this.readTracking_(
              wrappers, inline, nonLinearAds, nonLinear);
          resource.uri = this.resolveUri_(inline.uri, resource.uri);
          this.processNonLinearAd_(interstitials, currentTime, nonLinear,
              resource, tracking, adId, clickThroughUrl);
        }
      }
    }
    return interstitials;
  }

  /**
   * @param {!shaka.extern.xml.Node} node
   * @return {!Array<!shaka.extern.xml.Node>}
   * @private
   */
  getCreatives_(node) {
    const TXml = shaka.util.TXml;
    const creatives = TXml.findChild(node, 'Creatives');
    return creatives ? TXml.findChildren(creatives, 'Creative') : [];
  }

  /**
   * Reads the tracking for a creative in wrapper order, so the last
   * available click-through is the one closest to the InLine.
   * @param {!Array<!shaka.ads.VastInterstitialParser.Source_>} wrappers
   * @param {!shaka.ads.VastInterstitialParser.Source_} inline
   * @param {!shaka.extern.xml.Node} creative
   * @param {?shaka.extern.xml.Node} nonLinear
   * @return {{tracking: !shaka.extern.AdTrackingEvent,
   *     clickThroughUrl: ?string}}
   * @private
   */
  readTracking_(wrappers, inline, creative, nonLinear) {
    const TXml = shaka.util.TXml;
    const tracking = shaka.ads.Utils.createTracking();
    const eventNames = new Set(Object.keys(tracking));
    /** @type {!Array<shaka.ads.InterstitialTracker.Event>} */
    const progress = [];
    let clickThroughUrl = null;
    for (const source of [...wrappers, inline]) {
      const {node, uri} = source;
      const impressions = this.readUris_(node, 'Impression', uri);
      const errors = this.readUris_(node, 'Error', uri);
      if (impressions.length) {
        tracking.impression = (tracking.impression || []).concat(impressions);
      }
      if (errors.length) {
        tracking.error = (tracking.error || []).concat(errors);
      }
      let creatives = [creative];
      if (source != inline) {
        const tag = nonLinear ? 'NonLinearAds' : 'Linear';
        creatives = [].concat(...this.getCreatives_(node).map(
            (entry) => TXml.findChildren(entry, tag)));
      }
      let sourceClickThrough = null;
      for (const entry of creatives) {
        for (const events of TXml.findChildren(entry, 'TrackingEvents')) {
          for (const event of TXml.findChildren(events, 'Tracking')) {
            const name = event.attributes['event'];
            const url = TXml.getContents(event);
            if (!url) {
              continue;
            }
            const resolved = this.resolveUri_(uri, url);
            if (name == 'progress' && !nonLinear) {
              this.addProgress_(progress, event.attributes['offset'],
                  resolved);
            } else if (eventNames.has(name)) {
              (tracking[name] = tracking[name] || []).push(resolved);
            }
          }
        }
        const clicks = nonLinear ? (source == inline ? [nonLinear] :
          TXml.findChildren(entry, 'NonLinear')) :
          TXml.findChildren(entry, 'VideoClicks');
        for (const click of clicks) {
          const urls = this.readUris_(click, nonLinear ?
            'NonLinearClickTracking' : 'ClickTracking', uri);
          if (urls.length) {
            tracking.clickTracking =
                (tracking.clickTracking || []).concat(urls);
          }
          if (!sourceClickThrough && (!nonLinear || source == inline)) {
            const tag = TXml.findChild(click, nonLinear ?
              'NonLinearClickThrough' : 'ClickThrough');
            const url = tag && TXml.getContents(tag);
            if (url && shaka.ads.Utils.isHttpOrRelativeUri(url)) {
              sourceClickThrough = this.resolveUri_(uri, url);
            }
          }
        }
      }
      clickThroughUrl = sourceClickThrough || clickThroughUrl;
    }
    if (progress.length) {
      shaka.ads.InterstitialTracker.setProgressEvents(tracking, progress);
    }
    return {tracking, clickThroughUrl};
  }

  /**
   * @param {!Array<shaka.ads.InterstitialTracker.Event>} events
   * @param {?string} value
   * @param {string} uri
   * @private
   */
  addProgress_(events, value, uri) {
    const offset = (value || '').trim();
    if (/^\d+(?:\.\d+)?%$/.test(offset)) {
      const fraction = parseFloat(offset) / 100;
      if (fraction <= 1) {
        events.push({type: 'progress', fraction, urls: [uri]});
      }
    } else if (/^\d{2,}:\d{2}:\d{2}(?:\.\d{3})?$/.test(offset)) {
      const seconds = shaka.util.TextParser.parseTime(offset);
      if (seconds != null) {
        events.push({type: 'progress', offset: seconds, urls: [uri]});
      }
    }
  }

  /**
   * @param {!shaka.extern.xml.Node} node
   * @param {string} tag
   * @param {string} baseUri
   * @return {!Array<string>}
   * @private
   */
  readUris_(node, tag, baseUri) {
    const TXml = shaka.util.TXml;
    const urls = [];
    for (const child of TXml.findChildren(node, tag)) {
      const uri = TXml.getContents(child);
      if (uri) {
        urls.push(this.resolveUri_(baseUri, uri));
      }
    }
    return urls;
  }

  /**
   * @param {string} baseUri
   * @param {string} uri
   * @return {string}
   * @private
   */
  resolveUri_(baseUri, uri) {
    // Keep absolute URIs and their VAST macros in their original form.
    if (!baseUri || /^[a-z][a-z0-9+.-]*:/i.test(uri)) {
      return uri;
    }
    try {
      return shaka.util.URL.resolve(baseUri, uri);
    } catch (error) {
      // An opaque base, such as a data URI, cannot resolve relative paths.
      return uri;
    }
  }

  /**
   * @param {string} uri
   * @return {string}
   * @private
   */
  withoutFragment_(uri) {
    const normalized = shaka.util.URL.toAbsolute(uri);
    try {
      const url = new URL(normalized);
      url.hash = '';
      return url.toString();
    } catch (error) {
      return normalized.split('#')[0];
    }
  }

  /**
   * @param {!Array<shaka.extern.AdInterstitial>} interstitials
   * @param {?number} currentTime
   * @param {!shaka.extern.xml.Node} linear
   * @param {!shaka.extern.AdTrackingEvent} tracking
   * @param {?string} adId
   * @param {string} baseUri
   * @param {?string} clickThroughUrl
   * @private
   */
  processLinearAd_(interstitials, currentTime, linear, tracking, adId,
      baseUri, clickThroughUrl) {
    const TXml = shaka.util.TXml;
    let startTime = 0;
    if (currentTime != null) {
      startTime = currentTime;
    }
    let skipOffset = null;
    if (linear.attributes['skipoffset']) {
      skipOffset = shaka.util.TextParser.parseTime(
          linear.attributes['skipoffset']);
      if (isNaN(skipOffset)) {
        skipOffset = null;
      }
    }
    const mediaFiles = TXml.findChild(linear, 'MediaFiles');
    if (!mediaFiles) {
      return;
    }
    const medias = TXml.findChildren(mediaFiles, 'MediaFile');
    let checkMedias = medias;
    const streamingMedias = medias.filter((media) => {
      return media.attributes['delivery'] == 'streaming';
    });
    if (streamingMedias.length) {
      checkMedias = streamingMedias;
    }
    const sortedMedias = checkMedias.sort((a, b) => {
      const aHeight = parseInt(a.attributes['height'], 10) || 0;
      const bHeight = parseInt(b.attributes['height'], 10) || 0;
      return bHeight - aHeight;
    });
    for (const media of sortedMedias) {
      if (media.attributes['apiFramework']) {
        continue;
      }
      const adUrl = TXml.getContents(media);
      if (!adUrl) {
        continue;
      }
      interstitials.push(shaka.ads.Utils.createInterstitial({
        id: adId,
        startTime: startTime,
        uri: this.resolveUri_(baseUri, adUrl),
        mimeType: media.attributes['type'] || null,
        isSkippable: skipOffset != null,
        skipOffset,
        canJump: false,
        resumeOffset: 0,
        once: true,
        pre: currentTime == null,
        post: currentTime == Infinity,
        clickThroughUrl: clickThroughUrl,
        tracking: tracking,
      }));
      break;
    }
  }

  /**
   * @param {!Array<shaka.extern.AdInterstitial>} interstitials
   * @param {?number} currentTime
   * @param {!shaka.extern.xml.Node} nonLinear
   * @param {{uri: string, mimeType: string}} resource
   * @param {!shaka.extern.AdTrackingEvent} tracking
   * @param {?string} adId
   * @param {?string} clickThroughUrl
   * @private
   */
  processNonLinearAd_(interstitials, currentTime, nonLinear, resource,
      tracking, adId, clickThroughUrl) {
    const TXml = shaka.util.TXml;
    const width = TXml.parseAttr(nonLinear, 'width', TXml.parseInt) ||
        TXml.parseAttr(nonLinear, 'expandedWidth', TXml.parseInt);
    const height = TXml.parseAttr(nonLinear, 'height', TXml.parseInt) ||
        TXml.parseAttr(nonLinear, 'expandedHeight', TXml.parseInt);
    if (!width && !height) {
      return;
    }
    let playoutLimit = null;
    const minSuggestedDuration =
        nonLinear.attributes['minSuggestedDuration'];
    if (minSuggestedDuration) {
      playoutLimit = shaka.util.TextParser.parseTime(minSuggestedDuration);
    }
    let startTime = 0;
    if (currentTime != null) {
      startTime = currentTime;
    }
    interstitials.push(shaka.ads.Utils.createInterstitial({
      id: adId,
      startTime: startTime,
      uri: resource.uri,
      mimeType: resource.mimeType,
      canJump: false,
      resumeOffset: 0,
      playoutLimit,
      once: true,
      pre: currentTime == null,
      post: currentTime == Infinity,
      overlay: {
        viewport: {
          x: 0,
          y: 0,
        },
        topLeft: {
          x: 0,
          y: 0,
        },
        size: {
          x: width || 0,
          y: height || 0,
        },
      },
      clickThroughUrl: clickThroughUrl,
      tracking: tracking,
    }));
  }

  /**
   * Selects one resource per creative, in document order within each type.
   * @param {!shaka.extern.xml.Node} nonLinear
   * @return {!Promise<?{uri: string, mimeType: string}>}
   * @private
   */
  async selectNonLinearResource_(nonLinear) {
    const types = ['StaticResource', 'HTMLResource', 'IFrameResource'];
    for (const type of types) {
      for (const node of shaka.util.TXml.findChildren(nonLinear, type)) {
        const contents = shaka.util.TXml.getContents(node);
        if (!contents) {
          continue;
        }
        if (type == 'IFrameResource') {
          if (shaka.ads.Utils.isHttpOrRelativeUri(contents)) {
            return {uri: contents, mimeType: 'text/html'};
          }
          continue;
        }
        const creativeType = node.attributes['creativeType'] || '';
        const mimeType = shaka.util.MimeUtils.getBasicType(creativeType)
            .trim().toLowerCase();
        if (type == 'HTMLResource' || mimeType == 'text/html') {
          const uri = 'data:text/html;charset=UTF-8,' +
              encodeURIComponent(contents);
          return {uri, mimeType: 'text/html'};
        }
        if (mimeType.startsWith('image/')) {
          // eslint-disable-next-line no-await-in-loop
          if (await shaka.util.StreamUtils.isImageTypeSupported(mimeType)) {
            return {uri: contents, mimeType};
          }
        } else if (creativeType) {
          const device = shaka.device.DeviceFactory.getDevice();
          if (device.supportsMediaType(creativeType) ||
              shaka.media.ManifestParser.isSupported(mimeType)) {
            return {uri: contents, mimeType: creativeType};
          }
        }
      }
    }
    return null;
  }

  /**
   * @param {!shaka.extern.xml.Node} vmap
   * @return {!Array<{time: ?number, uri: string, allowMultipleAds: boolean,
   *     followWrappers: boolean}>}
   */
  parseVMAP(vmap) {
    const TXml = shaka.util.TXml;
    const ads = [];
    for (const adBreak of TXml.findChildren(vmap, 'vmap:AdBreak')) {
      const timeOffset = adBreak.attributes['timeOffset'];
      if (!timeOffset) {
        continue;
      }
      let time = null;
      if (timeOffset == 'start') {
        time = null;
      } else if (timeOffset == 'end') {
        time = Infinity;
      } else {
        time = shaka.util.TextParser.parseTime(timeOffset);
      }
      const adSource = TXml.findChild(adBreak, 'vmap:AdSource');
      if (!adSource) {
        continue;
      }
      const adTagURI = TXml.findChild(adSource, 'vmap:AdTagURI');
      if (!adTagURI) {
        continue;
      }
      const uri = TXml.getContents(adTagURI);
      if (!uri) {
        continue;
      }
      ads.push({
        time,
        uri,
        allowMultipleAds: TXml.parseAttr(adSource, 'allowMultipleAds',
            this.parseBoolean_) !== false,
        followWrappers: TXml.parseAttr(adSource, 'followRedirects',
            this.parseBoolean_) !== false,
      });
    }
    return ads;
  }

  /**
   * @param {string} value
   * @return {boolean}
   * @private
   */
  parseBoolean_(value) {
    return value == '1' || shaka.util.TXml.parseBoolean(value);
  }
};


/**
 * @typedef {{node: !shaka.extern.xml.Node, uri: string}}
 * @private
 */
shaka.ads.VastInterstitialParser.Source_;


/**
 * @private
 * @const {number}
 */
shaka.ads.VastInterstitialParser.MAX_WRAPPERS_ = 5;
