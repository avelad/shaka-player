/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('VastInterstitialParser', () => {
  const TXml = shaka.util.TXml;
  const VastInterstitialParser = shaka.ads.VastInterstitialParser;
  const parser = new VastInterstitialParser();

  const linearVast = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<VAST version="3.0">',
    '<Ad id="5925573263">',
    '<InLine>',
    '<Error>error_url</Error>',
    '<Error>error_url2</Error>',
    '<Impression>impression_url</Impression>',
    '<Impression>impression_url2</Impression>',
    '<Creatives>',
    '<Creative id="138381721867" sequence="1">',
    '<Linear>',
    '<Duration>00:00:10</Duration>',
    '<TrackingEvents>',
    '<Tracking event="start">start_url</Tracking>',
    '<Tracking event="start">start_url2</Tracking>',
    '<Tracking event="firstQuartile">firstQuartile_url</Tracking>',
    '<Tracking event="midpoint">midpoint_url</Tracking>',
    '<Tracking event="thirdQuartile">thirdQuartile_url</Tracking>',
    '<Tracking event="complete">complete_url</Tracking>',
    '<Tracking event="skip">skip_url</Tracking>',
    '<Tracking event="resume">resume_url</Tracking>',
    '<Tracking event="pause">pause_url</Tracking>',
    '<Tracking event="mute">mute_url</Tracking>',
    '<Tracking event="unmute">unmute_url</Tracking>',
    '</TrackingEvents>',
    '<VideoClicks>',
    '<ClickThrough id="1">',
    '<![CDATA[ foo.bar ]]>',
    '</ClickThrough>',
    '<ClickTracking id="1">click_tracking</ClickTracking>',
    '</VideoClicks>',
    '<MediaFiles>',
    '<MediaFile bitrate="140" delivery="progressive" ',
    'height="360" type="video/mp4" width="640">',
    '<![CDATA[test.mp4]]>',
    '</MediaFile>',
    '</MediaFiles>',
    '</Linear>',
    '</Creative>',
    '</Creatives>',
    '</InLine>',
    '</Ad>',
    '</VAST>',
  ].join('');

  /**
   * @param {string} xmlString
   * @return {!shaka.extern.xml.Node}
   */
  function parseVast(xmlString) {
    const node = TXml.parseXmlString(xmlString, 'VAST');
    goog.asserts.assert(node, 'Should have a VAST node!');
    return node;
  }

  describe('load', () => {
    /** @type {!Array<string>} */
    let requests;
    /** @type {!Array<string>} */
    let beacons;
    /** @type {!shaka.ads.VastInterstitialParser} */
    let loader;
    /** @type {!Map<string, {xml: string, uri: (string|undefined)}>} */
    let documents;

    beforeEach(() => {
      documents = new Map();
      requests = [];
      beacons = [];
      loader = new VastInterstitialParser((uri) => {
        requests.push(uri);
        const entry = documents.get(uri);
        if (!entry) {
          return Promise.reject(new Error('Ad tag is unavailable'));
        }
        const NetworkingEngine = shaka.net.NetworkingEngine;
        /** @type {shaka.extern.Response} */
        const response = {
          uri: entry.uri || uri,
          originalUri: uri,
          data: shaka.util.StringUtils.toUTF8(entry.xml),
          headers: {},
          originalRequest: NetworkingEngine.makeRequest(
              [uri], NetworkingEngine.defaultRetryParameters()),
        };
        return Promise.resolve(response);
      }, (uri) => { beacons.push(uri); });
    });

    const wrapper = (tag, attributes = '', contents = '', ad = '') =>
      `<Ad ${ad}><Wrapper ${attributes}><VASTAdTagURI>${tag}</VASTAdTagURI>` +
      contents + '</Wrapper></Ad>';
    const document = (...ads) => `<VAST>${ads.join('')}</VAST>`;
    const inline = (id, sequence = '') =>
      `<Ad id="${id}" ${sequence}><InLine><Creatives><Creative><Linear>` +
      '<MediaFiles><MediaFile type="video/mp4">ad.mp4</MediaFile>' +
      '</MediaFiles>' +
      '</Linear></Creative></Creatives></InLine></Ad>';

    it('reads the playback time after the initial VAST arrives', async () => {
      documents.set('http://ads.test/root', {xml: document(wrapper('next'))});
      documents.set('http://ads.test/next', {xml: document(inline('ad'))});
      let currentTime = null;
      const loading = loader.load('http://ads.test/root', () => currentTime);
      currentTime = 10;

      const [ad] = await loading;
      expect(ad.startTime).toBe(10);
      expect(ad.pre).toBe(false);
    });

    it('inherits tracking and resolves URLs against each response',
        async () => {
          const overlay = [
            '<Creative><NonLinearAds><NonLinear width="300" height="50">',
            '<IFrameResource>overlay.html</IFrameResource>',
            '<NonLinearClickThrough>landing.html</NonLinearClickThrough>',
            '<NonLinearClickTracking>overlay-click</NonLinearClickTracking>',
            '</NonLinear></NonLinearAds></Creative>',
          ].join('');
          const outerTracking = [
            '<Impression>impression</Impression><Error>error</Error>',
            '<Creatives><Creative><Linear><TrackingEvents>',
            '<Tracking event="start">start</Tracking>',
            '<Tracking event="progress" offset="00:00:02">two</Tracking>',
            '</TrackingEvents><VideoClicks>',
            '<ClickThrough>https://outer.example/</ClickThrough>',
            '<ClickTracking>click</ClickTracking>',
            '</VideoClicks></Linear></Creative><Creative><NonLinearAds>',
            '<TrackingEvents><Tracking event="start">overlay-start</Tracking>',
            '</TrackingEvents><NonLinear>',
            '<NonLinearClickTracking>overlay-click</NonLinearClickTracking>',
            '</NonLinear></NonLinearAds></Creative></Creatives>',
          ].join('');
          const innerTracking = [
            '<Impression>impression</Impression><Error>error</Error>',
            '<Creatives><Creative><Linear><TrackingEvents>',
            '<Tracking event="progress" offset="50%">half</Tracking>',
            '<Tracking event="progress" offset="101%">invalid</Tracking>',
            '</TrackingEvents><VideoClicks>',
            '<ClickThrough>https://inner.example/</ClickThrough>',
            '<ClickTracking>click</ClickTracking>',
            '</VideoClicks></Linear></Creative><Creative><NonLinearAds>',
            '<NonLinear>',
            '<NonLinearClickTracking>overlay-click</NonLinearClickTracking>',
            '</NonLinear>',
            '</NonLinearAds></Creative></Creatives>',
          ].join('');
          documents.set('http://ads.test/root', {
            uri: 'http://ads.test/outer/root.xml',
            xml: document(wrapper('wrapper.xml', '', outerTracking)),
          });
          documents.set('http://ads.test/outer/wrapper.xml', {
            uri: 'http://ads.test/inner/wrapper.xml',
            xml: document(wrapper('../inline/ad.xml', '', innerTracking)),
          });
          documents.set('http://ads.test/inline/ad.xml', {
            xml: linearVast.replace('</Creatives>', overlay + '</Creatives>'),
          });

          const [video, image] = await loader.load('http://ads.test/root',
              () => 25);
          expect(video.startTime).toBe(25);
          expect(video.uri).toBe('http://ads.test/inline/test.mp4');
          expect(video.clickThroughUrl).toBe('http://ads.test/inline/foo.bar');
          expect(video.tracking.impression).toEqual([
            'http://ads.test/outer/impression', 'http://ads.test/inner/impression',
            'http://ads.test/inline/impression_url',
            'http://ads.test/inline/impression_url2',
          ]);
          expect(video.tracking.error).toEqual([
            'http://ads.test/outer/error', 'http://ads.test/inner/error',
            'http://ads.test/inline/error_url',
            'http://ads.test/inline/error_url2',
          ]);
          expect(video.tracking.start).toEqual([
            'http://ads.test/outer/start', 'http://ads.test/inline/start_url',
            'http://ads.test/inline/start_url2',
          ]);
          expect(video.tracking.clickTracking).toEqual([
            'http://ads.test/outer/click', 'http://ads.test/inner/click',
            'http://ads.test/inline/click_tracking',
          ]);
          expect(image.uri).toBe('http://ads.test/inline/overlay.html');
          expect(image.clickThroughUrl).toBe(
              'http://ads.test/inline/landing.html');
          expect(image.tracking.impression).toEqual(video.tracking.impression);
          expect(image.tracking.start).toEqual([
            'http://ads.test/outer/overlay-start',
          ]);
          expect(image.tracking.clickTracking).toEqual([
            'http://ads.test/outer/overlay-click',
            'http://ads.test/inner/overlay-click',
            'http://ads.test/inline/overlay-click',
          ]);
          expect(beacons).toEqual([]);

          const events = shaka.ads.InterstitialTracker.fromTracking(
              video.tracking);
          const tracker = new shaka.ads.InterstitialTracker(() => events,
              (url) => { beacons.push(url); });
          tracker.onProgress(0, 3);
          tracker.onProgress(3, 4, 10);
          tracker.onProgress(4, 5, 10);
          tracker.onProgress(0, 10, 10);
          expect(beacons).toEqual([
            'http://ads.test/outer/two', 'http://ads.test/inner/half',
          ]);

          documents.set('http://ads.test/inline/ad.xml', {
            xml: linearVast.replace('foo.bar', ''),
          });
          const [withoutClickThrough] = await loader.load(
              'http://ads.test/root', () => 25);
          expect(withoutClickThrough.clickThroughUrl).toBe(
              'https://inner.example/');
        });

    it('loads VMAP breaks through wrappers in document order', async () => {
      const adBreak = (time, uri, attributes = '') =>
        `<vmap:AdBreak timeOffset="${time}"><vmap:AdSource ${attributes}>` +
        `<vmap:AdTagURI>${uri}</vmap:AdTagURI>` +
        '</vmap:AdSource></vmap:AdBreak>';
      documents.set('http://ads.test/vmap', {
        uri: 'http://ads.test/dir/vmap.xml',
        xml: '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap">' +
          adBreak('00:00:15', 'wrapper.xml') + adBreak('end', 'inline.xml') +
          adBreak('start', 'wrapper.xml', 'followRedirects="false"') +
          '</vmap:VMAP>',
      });
      documents.set('http://ads.test/dir/wrapper.xml', {
        xml: document(wrapper('inline.xml')),
      });
      documents.set('http://ads.test/dir/inline.xml', {xml: document(inline('ad'))});
      let readTime = false;
      const ads = await loader.load('http://ads.test/vmap', () => {
        readTime = true;
        return null;
      });

      expect(ads.map((ad) => ad.startTime)).toEqual([15, Infinity]);
      expect(ads.map((ad) => ad.id)).toEqual(['ad', 'ad']);
      expect(readTime).toBe(false);
    });

    it('honors followAdditionalWrappers and the default single-ad limit',
        async () => {
          documents.set('http://ads.test/root', {xml: document(wrapper('next',
              'followAdditionalWrappers="false"'))});
          documents.set('http://ads.test/next', {xml: document(wrapper('forbidden'),
              inline('pod', 'sequence="1"'), inline('first'),
              inline('second'))});

          const ads = await loader.load('http://ads.test/root', () => null);
          expect(ads.map((ad) => ad.id)).toEqual(['first']);
          expect(requests).toEqual(['http://ads.test/root', 'http://ads.test/next']);
        });

    it('orders pods and uses a stand-alone ad for an empty wrapper',
        async () => {
          documents.set('http://ads.test/root', {xml: document(wrapper('next',
              'allowMultipleAds="true"'))});
          documents.set('http://ads.test/next', {xml: document(
              inline('last', 'sequence="3"'),
              wrapper('empty', 'fallbackOnNoAd="true"', '', 'sequence="2"'),
              inline('fallback'), inline('first', 'sequence="1"'))});
          documents.set('http://ads.test/empty', {xml: document()});

          const ads = await loader.load('http://ads.test/root', () => null);
          expect(ads.map((ad) => ad.id)).toEqual(['first', 'fallback', 'last']);
        });

    for (const [xml, code] of [
      [null, 301], ['<notVast/>', 100],
      ['<VAST><Error>empty?e=[ERRORCODE]</Error></VAST>', 303],
    ]) {
      it(`reports VAST error ${code} through the chain and continues`,
          async () => {
            const errorTag = '<Error>error?e=[ERRORCODE]</Error>';
            documents.set('http://ads.test/root', {xml: document(
                wrapper('next/ad', '', errorTag), inline('alternative'))});
            documents.set('http://ads.test/next/ad', {
              xml: document(wrapper('final', '', errorTag)),
            });
            if (xml) {
              documents.set('http://ads.test/next/final', {xml});
            }

            const ads = await loader.load('http://ads.test/root', () => null);
            expect(ads.map((ad) => ad.id)).toEqual(['alternative']);
            const errors = [`http://ads.test/error?e=${code}`,
              `http://ads.test/next/error?e=${code}`];
            if (code == 303) {
              errors.push('http://ads.test/next/empty?e=303');
            }
            expect(beacons).toEqual(errors);
          });
    }

    it('stops at five wrappers and reports redirect loops', async () => {
      for (let i = 0; i <= 5; ++i) {
        documents.set(`http://ads.test/step-${i}`, {
          xml: document(wrapper(`step-${i + 1}`, '',
              `<Error>error-${i}?e=[ERRORCODE]</Error>`)),
        });
      }
      expect(await loader.load('http://ads.test/step-0', () => null)).toEqual([]);
      expect(requests.length).toBe(6);
      expect(beacons.length).toBe(6);
      expect(beacons).toContain('http://ads.test/error-0?e=302');
      expect(beacons).toContain('http://ads.test/error-5?e=302');

      requests.length = 0;
      beacons.length = 0;
      documents.set('http://ads.test/step-1', {
        uri: 'http://ads.test/step-0#redirect',
        xml: document(wrapper('step-1')),
      });
      expect(await loader.load('http://ads.test/step-0', () => null)).toEqual([]);
      expect(requests.length).toBe(2);
      expect(beacons).toEqual(['http://ads.test/error-0?e=302']);
    });
  });

  describe('parseVastToInterstitials', () => {
    it('parses a linear ad as a pre-roll for a null time', async () => {
      const interstitials = await parser
          .parseVastToInterstitials(parseVast(linearVast), null);

      expect(interstitials.length).toBe(1);
      /** @type {!shaka.extern.AdInterstitial} */
      const expectedInterstitial = {
        id: '5925573263',
        groupId: null,
        startTime: 0,
        endTime: null,
        uri: 'test.mp4',
        mimeType: 'video/mp4',
        isSkippable: false,
        skipOffset: null,
        skipFor: null,
        canJump: false,
        resumeOffset: 0,
        playoutLimit: null,
        once: true,
        pre: true,
        post: false,
        timelineRange: false,
        loop: false,
        overlay: null,
        displayOnBackground: false,
        currentVideo: null,
        background: null,
        clickThroughUrl: 'foo.bar',
        tracking: {
          impression: ['impression_url', 'impression_url2'],
          clickTracking: ['click_tracking'],
          start: ['start_url', 'start_url2'],
          firstQuartile: ['firstQuartile_url'],
          midpoint: ['midpoint_url'],
          thirdQuartile: ['thirdQuartile_url'],
          complete: ['complete_url'],
          skip: ['skip_url'],
          error: ['error_url', 'error_url2'],
          resume: ['resume_url'],
          pause: ['pause_url'],
          mute: ['mute_url'],
          unmute: ['unmute_url'],
        },
      };
      expect(interstitials[0]).toEqual(expectedInterstitial);
    });

    it('uses currentTime as the start time for a mid-roll', async () => {
      const interstitials = await parser
          .parseVastToInterstitials(parseVast(linearVast), 5);

      expect(interstitials.length).toBe(1);
      expect(interstitials[0].startTime).toBe(5);
      expect(interstitials[0].pre).toBe(false);
      expect(interstitials[0].post).toBe(false);
    });

    it('parses a linear ad as a post-roll for an infinite time', async () => {
      const interstitials = await parser
          .parseVastToInterstitials(parseVast(linearVast), Infinity);

      expect(interstitials.length).toBe(1);
      expect(interstitials[0].pre).toBe(false);
      expect(interstitials[0].post).toBe(true);
    });

    it('parses a non-linear ad as an overlay', async () => {
      const vast = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<VAST version="3.0">',
        '<Ad id="5925573263">',
        '<InLine>',
        '<Error>error_url</Error>',
        '<Impression>impression_url</Impression>',
        '<Creatives>',
        '<Creative id="138381721867" sequence="1">',
        '<NonLinearAds>',
        '<TrackingEvents>',
        '<Tracking event="start">start_url</Tracking>',
        '<Tracking event="firstQuartile">firstQuartile_url</Tracking>',
        '<Tracking event="midpoint">midpoint_url</Tracking>',
        '<Tracking event="thirdQuartile">thirdQuartile_url</Tracking>',
        '<Tracking event="complete">complete_url</Tracking>',
        '<Tracking event="skip">skip_url</Tracking>',
        '<Tracking event="resume">resume_url</Tracking>',
        '<Tracking event="pause">pause_url</Tracking>',
        '<Tracking event="mute">mute_url</Tracking>',
        '<Tracking event="unmute">unmute_url</Tracking>',
        '</TrackingEvents>',
        '<NonLinear width="535" height="80" minSuggestedDuration="00:00:05">',
        '<StaticResource creativeType="image/png">',
        '<![CDATA[test.png]]>',
        '</StaticResource>',
        '<NonLinearClickThrough>',
        '<![CDATA[foo.bar]]>',
        '</NonLinearClickThrough>',
        '<NonLinearClickTracking>click_tracking</NonLinearClickTracking>',
        '</NonLinear>',
        '</NonLinearAds>',
        '</Creative>',
        '</Creatives>',
        '</InLine>',
        '</Ad>',
        '</VAST>',
      ].join('');

      const interstitials = await parser
          .parseVastToInterstitials(parseVast(vast), null);

      expect(interstitials.length).toBe(1);
      /** @type {!shaka.extern.AdInterstitial} */
      const expectedInterstitial = {
        id: '5925573263',
        groupId: null,
        startTime: 0,
        endTime: null,
        uri: 'test.png',
        mimeType: 'image/png',
        isSkippable: false,
        skipOffset: null,
        skipFor: null,
        canJump: false,
        resumeOffset: 0,
        playoutLimit: 5,
        once: true,
        pre: true,
        post: false,
        timelineRange: false,
        loop: false,
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
            x: 535,
            y: 80,
          },
        },
        displayOnBackground: false,
        currentVideo: null,
        background: null,
        clickThroughUrl: 'foo.bar',
        tracking: {
          impression: ['impression_url'],
          clickTracking: ['click_tracking'],
          start: ['start_url'],
          firstQuartile: ['firstQuartile_url'],
          midpoint: ['midpoint_url'],
          thirdQuartile: ['thirdQuartile_url'],
          complete: ['complete_url'],
          skip: ['skip_url'],
          error: ['error_url'],
          resume: ['resume_url'],
          pause: ['pause_url'],
          mute: ['mute_url'],
          unmute: ['unmute_url'],
        },
      };
      expect(interstitials[0]).toEqual(expectedInterstitial);
    });

    describe('non-linear resource selection', () => {
      /**
       * @param {string} resources
       * @return {!Promise<!Array<shaka.extern.AdInterstitial>>}
       */
      function parseResources(resources) {
        const vast = '<VAST><Ad><InLine><Creatives><Creative><NonLinearAds>' +
            '<NonLinear width="300" height="50">' + resources +
            '</NonLinear></NonLinearAds></Creative></Creatives></InLine>' +
            '</Ad></VAST>';
        return parser.parseVastToInterstitials(
            parseVast(vast), /* currentTime= */ 0);
      }

      it('uses an external iframe URL verbatim', async () => {
        const ads = await parseResources('<IFrameResource>' +
            '<![CDATA[https://ads.example/frame?a=1&b=2]]></IFrameResource>');
        expect(ads).toEqual([jasmine.objectContaining({
          uri: 'https://ads.example/frame?a=1&b=2',
          mimeType: 'text/html',
        })]);
      });

      it('prefers inline HTML over an iframe', async () => {
        const ads = await parseResources(
            '<IFrameResource>https://ads.example/frame</IFrameResource>' +
            '<HTMLResource><![CDATA[<b>Ad</b>]]></HTMLResource>');
        expect(ads).toEqual([jasmine.objectContaining({
          uri: 'data:text/html;charset=UTF-8,%3Cb%3EAd%3C%2Fb%3E',
          mimeType: 'text/html',
        })]);
      });

      it('skips an iframe with an unsupported URI scheme', async () => {
        expect(await parseResources(
            '<IFrameResource>javascript:alert(1)</IFrameResource>'))
            .toEqual([]);
        expect(await parseResources('<IFrameResource/>')).toEqual([]);
      });

      it('prefers the first supported static resource', async () => {
        const webp = '<StaticResource creativeType="image/webp">' +
            'first.webp</StaticResource>';
        const png = '<StaticResource creativeType="image/png">' +
            'second.png</StaticResource>';
        const support = spyOn(shaka.util.StreamUtils, 'isImageTypeSupported');
        support.and.resolveTo(true);
        let ads = await parseResources(
            '<IFrameResource>https://ads.example/frame</IFrameResource>' +
            '<HTMLResource><![CDATA[<b>Ad</b>]]></HTMLResource>' + webp + png);
        expect(ads.map((ad) => ad.uri)).toEqual(['first.webp']);

        support.and.callFake((type) => Promise.resolve(type == 'image/png'));
        ads = await parseResources(webp + png);
        expect(ads.map((ad) => ad.uri)).toEqual(['second.png']);
      });

      it('skips empty and unsupported resources', async () => {
        const ads = await parseResources(
            '<IFrameResource>https://ads.example/frame</IFrameResource>' +
            '<HTMLResource/>' +
            '<HTMLResource><![CDATA[<b>Ad</b>]]></HTMLResource>' +
            '<StaticResource creativeType="image/unknown">a</StaticResource>' +
            '<StaticResource/>');
        expect(ads).toEqual([jasmine.objectContaining({
          uri: 'data:text/html;charset=UTF-8,%3Cb%3EAd%3C%2Fb%3E',
          mimeType: 'text/html',
        })]);
      });
    });

    it('returns an empty array for an empty VAST', async () => {
      const vast = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<VAST version="3.0">',
        '</VAST>',
      ].join('');

      const interstitials = await parser
          .parseVastToInterstitials(parseVast(vast), null);
      expect(interstitials).toEqual([]);
    });
  });

  describe('parseVMAP', () => {
    it('parses ad breaks with start, mid and end offsets', () => {
      const vmap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap"',
        ' version="1.0">',
        '<vmap:AdBreak timeOffset="start" breakType="linear"',
        ' breakId="preroll">',
        '<vmap:AdSource id="preroll-ad-1" allowMultipleAds="false"',
        ' followRedirects="true">',
        '<vmap:AdTagURI templateType="vast3"><![CDATA[http://ads.test/preroll]]>',
        '</vmap:AdTagURI>',
        '</vmap:AdSource>',
        '</vmap:AdBreak>',
        '<vmap:AdBreak timeOffset="00:00:15.000" breakType="linear"',
        ' breakId="midroll-1">',
        '<vmap:AdSource id="midroll-1-ad-1" allowMultipleAds="false"',
        ' followRedirects="true">',
        '<vmap:AdTagURI templateType="vast3"><![CDATA[http://ads.test/midroll]]>',
        '</vmap:AdTagURI>',
        '</vmap:AdSource>',
        '</vmap:AdBreak>',
        '<vmap:AdBreak timeOffset="end" breakType="linear"',
        ' breakId="postroll">',
        '<vmap:AdSource id="postroll-ad-1" allowMultipleAds="false"',
        ' followRedirects="true">',
        '<vmap:AdTagURI templateType="vast3"><![CDATA[http://ads.test/postroll]]>',
        '</vmap:AdTagURI>',
        '</vmap:AdSource>',
        '</vmap:AdBreak>',
        '</vmap:VMAP>',
      ].join('');

      const node = TXml.parseXmlString(vmap, 'vmap:VMAP');
      goog.asserts.assert(node, 'Should have a VMAP node!');
      const ads = parser.parseVMAP(node);
      expect(ads).toEqual([
        {
          time: null, uri: 'http://ads.test/preroll',
          allowMultipleAds: false, followWrappers: true,
        },
        {
          time: 15, uri: 'http://ads.test/midroll',
          allowMultipleAds: false, followWrappers: true,
        },
        {
          time: Infinity, uri: 'http://ads.test/postroll',
          allowMultipleAds: false, followWrappers: true,
        },
      ]);
    });

    it('skips ad breaks without a time offset or ad tag URI', () => {
      const vmap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap"',
        ' version="1.0">',
        '<vmap:AdBreak breakType="linear" breakId="no-offset">',
        '<vmap:AdSource>',
        '<vmap:AdTagURI templateType="vast3"><![CDATA[http://ads.test/vast]]>',
        '</vmap:AdTagURI>',
        '</vmap:AdSource>',
        '</vmap:AdBreak>',
        '<vmap:AdBreak timeOffset="start" breakType="linear"',
        ' breakId="no-source"/>',
        '</vmap:VMAP>',
      ].join('');

      const node = TXml.parseXmlString(vmap, 'vmap:VMAP');
      goog.asserts.assert(node, 'Should have a VMAP node!');
      expect(parser.parseVMAP(node)).toEqual([]);
    });
  });
});
