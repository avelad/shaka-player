/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.PreferenceBasedCriteria');

goog.require('shaka.config.CodecSwitchingStrategy');
goog.require('shaka.log');
goog.require('shaka.media.AdaptationSet');
goog.require('shaka.media.AdaptationSetCriteria');
goog.require('shaka.media.Capabilities');
goog.require('shaka.util.LanguageUtils');


/**
 * @implements {shaka.media.AdaptationSetCriteria}
 * @final
 */
shaka.media.PreferenceBasedCriteria = class {
  /** */
  constructor() {
    /** @private {?shaka.media.AdaptationSetCriteria.Configuration} */
    this.config_ = null;
  }

  /**
   * @override
   */
  configure(config) {
    this.config_ = config;
  }

  /**
   * @override
   */
  create(variants) {
    const Class = shaka.media.PreferenceBasedCriteria;

    let current = [];

    const byLanguage = Class.filterByLanguage_(variants, this.config_.language);
    const byPrimary = variants.filter((variant) => variant.primary);

    if (byLanguage.length) {
      current = byLanguage;
    } else if (byPrimary.length) {
      current = byPrimary;
    } else {
      current = variants;
    }

    // Now refine the choice based on role preference.  Even the empty string
    // works here, and will match variants without any roles.
    const byRole = Class.filterVariantsByRole_(current, this.config_.role);
    if (byRole.length) {
      current = byRole;
    } else {
      shaka.log.warning('No exact match for variant role could be found.');
    }

    if (this.config_.videoLayout) {
      const byVideoLayout = Class.filterVariantsByVideoLayout_(
          current, this.config_.videoLayout);
      if (byVideoLayout.length) {
        current = byVideoLayout;
      } else {
        shaka.log.warning(
            'No exact match for the video layout could be found.');
      }
    }

    if (this.config_.hdrLevel) {
      const byHdrLevel = Class.filterVariantsByHDRLevel_(
          current, this.config_.hdrLevel);
      if (byHdrLevel.length) {
        current = byHdrLevel;
      } else {
        shaka.log.warning(
            'No exact match for the hdr level could be found.');
      }
    }

    if (this.config_.channelCount) {
      const byChannel = Class.filterVariantsByAudioChannelCount_(
          current, this.config_.channelCount);
      if (byChannel.length) {
        current = byChannel;
      } else {
        shaka.log.warning(
            'No exact match for the channel count could be found.');
      }
    }

    if (this.config_.audioLabel) {
      const byLabel = Class.filterVariantsByAudioLabel_(
          current, this.config_.audioLabel);
      if (byLabel.length) {
        current = byLabel;
      } else {
        shaka.log.warning('No exact match for audio label could be found.');
      }
    }

    if (this.config_.videoLabel) {
      const byLabel = Class.filterVariantsByVideoLabel_(
          current, this.config_.videoLabel);
      if (byLabel.length) {
        current = byLabel;
      } else {
        shaka.log.warning('No exact match for video label could be found.');
      }
    }

    const bySpatialAudio = Class.filterVariantsBySpatialAudio_(
        current, this.config_.spatialAudio);
    if (bySpatialAudio.length) {
      current = bySpatialAudio;
    } else {
      shaka.log.warning('No exact match for spatial audio could be found.');
    }

    if (this.config_.audioCodec) {
      const byAudioCodec = Class.filterVariantsByAudioCodec_(
          current, this.config_.audioCodec);
      if (byAudioCodec.length) {
        current = byAudioCodec;
      } else {
        shaka.log.warning('No exact match for audio codec could be found.');
      }
    }

    const supportsSmoothCodecTransitions =
      this.config_.codecSwitchingStrategy ==
      shaka.config.CodecSwitchingStrategy.SMOOTH &&
        shaka.media.Capabilities.isChangeTypeSupported();

    return new shaka.media.AdaptationSet(current[0], current,
        !supportsSmoothCodecTransitions);
  }

  /**
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} preferredLanguage
   * @return {!Array<shaka.extern.Variant>}
   * @private
   */
  static filterByLanguage_(variants, preferredLanguage) {
    const LanguageUtils = shaka.util.LanguageUtils;

    /** @type {string} */
    const preferredLocale = LanguageUtils.normalize(preferredLanguage);

    /** @type {?string} */
    const closestLocale = LanguageUtils.findClosestLocale(
        preferredLocale,
        variants.map((variant) => LanguageUtils.getLocaleForVariant(variant)));

    // There were no locales close to what we preferred.
    if (!closestLocale) {
      return [];
    }

    // Find the variants that use the closest variant.
    return variants.filter((variant) => {
      return closestLocale == LanguageUtils.getLocaleForVariant(variant);
    });
  }

  /**
   * Filter Variants by role.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} preferredRole
   * @return {!Array<shaka.extern.Variant>}
   * @private
   */
  static filterVariantsByRole_(variants, preferredRole) {
    return variants.filter((variant) => {
      if (!variant.audio) {
        return false;
      }

      if (preferredRole) {
        return variant.audio.roles.includes(preferredRole);
      } else {
        return variant.audio.roles.length == 0;
      }
    });
  }

  /**
   * Filter Variants by audio label.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} preferredLabel
   * @return {!Array<shaka.extern.Variant>}
   * @private
   */
  static filterVariantsByAudioLabel_(variants, preferredLabel) {
    return variants.filter((variant) => {
      if (!variant.audio || !variant.audio.label) {
        return false;
      }

      const label1 = variant.audio.label.toLowerCase();
      const label2 = preferredLabel.toLowerCase();
      return label1 == label2;
    });
  }

  /**
   * Filter Variants by video label.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} preferredLabel
   * @return {!Array<shaka.extern.Variant>}
   * @private
   */
  static filterVariantsByVideoLabel_(variants, preferredLabel) {
    return variants.filter((variant) => {
      if (!variant.video || !variant.video.label) {
        return false;
      }

      const label1 = variant.video.label.toLowerCase();
      const label2 = preferredLabel.toLowerCase();
      return label1 == label2;
    });
  }

  /**
   * Filter Variants by channelCount.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {number} channelCount
   * @return {!Array<shaka.extern.Variant>}
   * @private
   */
  static filterVariantsByAudioChannelCount_(variants, channelCount) {
    return variants.filter((variant) => {
      if (variant.audio && variant.audio.channelsCount &&
          variant.audio.channelsCount != channelCount) {
        return false;
      }
      return true;
    });
  }

  /**
   * Filters variants according to the given hdr level config.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} hdrLevel
   * @private
   */
  static filterVariantsByHDRLevel_(variants, hdrLevel) {
    if (hdrLevel == 'AUTO') {
      // Auto detect the ideal HDR level.
      if (window.matchMedia('(color-gamut: p3)').matches) {
        const someHLG = variants.some((variant) => {
          if (variant.video && variant.video.hdr &&
              variant.video.hdr == 'HLG') {
            return true;
          }
          return false;
        });
        hdrLevel = someHLG ? 'HLG' : 'PQ';
      } else {
        hdrLevel = 'SDR';
      }
    }
    return variants.filter((variant) => {
      if (variant.video && variant.video.hdr && variant.video.hdr != hdrLevel) {
        return false;
      }
      return true;
    });
  }


  /**
   * Filters variants according to the given video layout config.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} videoLayout
   * @private
   */
  static filterVariantsByVideoLayout_(variants, videoLayout) {
    return variants.filter((variant) => {
      if (variant.video && variant.video.videoLayout &&
          variant.video.videoLayout != videoLayout) {
        return false;
      }
      return true;
    });
  }


  /**
   * Filters variants according to the given spatial audio config.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {boolean} spatialAudio
   * @private
   */
  static filterVariantsBySpatialAudio_(variants, spatialAudio) {
    return variants.filter((variant) => {
      if (variant.audio && variant.audio.spatialAudio != spatialAudio) {
        return false;
      }
      return true;
    });
  }


  /**
   * Filters variants according to the given audio codec.
   *
   * @param {!Array<shaka.extern.Variant>} variants
   * @param {string} audioCodec
   * @private
   */
  static filterVariantsByAudioCodec_(variants, audioCodec) {
    return variants.filter((variant) => {
      if (variant.audio && variant.audio.codecs != audioCodec) {
        return false;
      }
      return true;
    });
  }
};