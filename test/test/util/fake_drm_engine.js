/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A fake DrmEngine.
 *
 * @extends {shaka.drm.DrmEngine}
 */
shaka.test.FakeDrmEngine = class {
  constructor() {
    /** @private {!Array<string>} */
    this.offlineSessions_ = [];
    /** @private {?shaka.extern.DrmInfo} */
    this.drmInfo_ = null;

    const resolved = Promise.resolve();

    /** @type {!jasmine.Spy} */
    this.attach = jasmine.createSpy('attach');
    this.attach.and.returnValue(resolved);

    /** @type {!jasmine.Spy} */
    this.configure = jasmine.createSpy('configure');

    // Because of the |IDestroyable| interface, we need to cast destroy to be
    // a function so that closure will understand that FakeDrmEngine still meets
    // the interface requirements.
    /** @type {!jasmine.Spy} */
    const destroySpy = jasmine.createSpy('destroy');
    destroySpy.and.returnValue(resolved);
    this.destroy = shaka.test.Util.spyFunc(destroySpy);

    /** @type {!jasmine.Spy} */
    this.getDrmInfo = jasmine.createSpy('getDrmInfo');
    // We use |callFake| to ensure that updated values of |this.drmInfo_| will
    // be returned.
    this.getDrmInfo.and.callFake(() => this.drmInfo_);

    /** @type {!jasmine.Spy} */
    this.newInitData = jasmine.createSpy('newInitData');
    this.newInitData.and.callFake((initDataType, initData) => {
      const num = 1 + this.offlineSessions_.length;
      this.offlineSessions_.push('session-' + num);
    });

    /** @type {!jasmine.Spy} */
    this.waitForActiveRequests = jasmine.createSpy('waitForActiveRequests');
    this.waitForActiveRequests.and.returnValue(Promise.resolve());

    /** @type {!jasmine.Spy} */
    this.getExpiration = jasmine.createSpy('getExpiration');
    this.getExpiration.and.returnValue(Infinity);

    /** @type {!jasmine.Spy} */
    this.getLicenseTime = jasmine.createSpy('getLicenseTime');
    this.getLicenseTime.and.returnValue(NaN);

    /** @type {!jasmine.Spy} */
    this.getKeyStatuses = jasmine.createSpy('getKeyStatuses');
    this.getKeyStatuses.and.returnValue({});

    /** @type {!jasmine.Spy} */
    this.getSessionIds = jasmine.createSpy('getSessionIds');
    this.getSessionIds.and.callFake(() => this.offlineSessions_);

    /** @type {!jasmine.Spy} */
    this.initForPlayback = jasmine.createSpy('initForPlayback');
    this.initForPlayback.and.returnValue(resolved);

    /** @type {!jasmine.Spy} */
    this.initForStorage = jasmine.createSpy('initForStorage');
    this.initForStorage.and.returnValue(resolved);

    /** @type {!jasmine.Spy} */
    this.initialized = jasmine.createSpy('initialized');
    this.initialized.and.returnValue(true);

    /** @type {!jasmine.Spy} */
    this.keySystem = jasmine.createSpy('keySystem');
    this.keySystem.and.returnValue('com.example.fake');

    /** @type {!jasmine.Spy} */
    this.supportsVariant = jasmine.createSpy('supportsVariant');
    this.supportsVariant.and.returnValue(true);

    /** @type {!jasmine.Spy} */
    this.setSrcEquals = jasmine.createSpy('setSrcEquals');
  }

  /**
   * @param {shaka.extern.DrmInfo} info
   */
  setDrmInfo(info) {
    this.drmInfo_ = info;
  }

  /**
   * @param {!Array<string>} sessions
   */
  setSessionIds(sessions) {
    // Copy the values to break the reference to the input value.
    this.offlineSessions_ = sessions.map((s) => s);
  }

  /**
   * @override
   */
  hasManifestInitData() {
    return true;
  }
};
