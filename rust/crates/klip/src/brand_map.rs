use serde::{Deserialize, Serialize};

/// Minimum linear gain corresponding to `VOLUME_DB_MIN`.
/// Mirrors `apps/web/src/timeline/audio-display.ts`:
/// `MIN_LINEAR_GAIN = 10 ** (VOLUME_DB_MIN / 20)`.
pub const VOLUME_DB_MIN: f64 = -60.0;
pub const VOLUME_DB_MAX: f64 = 20.0;
pub const MIN_LINEAR_GAIN: f64 = 0.001; // 10^(-60/20)
/// Mirrors the `klip_brand_layers.volume` column default (Task 2 schema).
pub const DEFAULT_VOLUME: f64 = 0.35;
/// Mirrors `apps/web/src/animation/transform.ts`.
pub const MIN_TRANSFORM_SCALE: f64 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KlipBrandKind {
    Image,
    Video,
    Audio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrandTrack {
    Graphic,
    Video,
    Audio,
}

/// Anchor waktu layer template. Cermin TS: `apps/web/src/klip/template-resolve.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrandAnchor {
    #[default]
    Start,
    MainEnd,
}

/// Cara layer menyesuaikan diri terhadap kanvas.
/// Cermin TS: `BrandFit` di `apps/web/src/klip/brand-map.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BrandFit {
    /// Skala manual dari field `scale`.
    #[default]
    Free,
    /// Lebar selalu memenuhi lebar kanvas; tinggi mengikuti rasio asli dan
    /// boleh melewati kanvas (tidak di-clamp).
    FullWidth,
}

/// A Klip brand layer. Field-for-field with the Klip model
/// (`klip_brand_layers` table, Task 2) plus `z` ordering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KlipBrandLayer {
    pub id: String,
    pub kind: KlipBrandKind,
    pub enabled: bool,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotate: f64,
    pub opacity: f64,
    pub full: bool,
    pub anchor: BrandAnchor,
    pub fit: BrandFit,
    pub start: f64,
    pub dur: f64,
    pub volume: f64,
    pub duck: bool,
    pub z: i32,
}

impl Default for KlipBrandLayer {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: KlipBrandKind::Image,
            enabled: true,
            x: 0.06,
            y: 0.05,
            scale: 0.36,
            rotate: 0.0,
            opacity: 100.0,
            full: true,
            anchor: BrandAnchor::Start,
            fit: BrandFit::Free,
            start: 0.0,
            dur: 0.0,
            volume: 0.35,
            duck: false,
            z: 0,
        }
    }
}

/// Context needed to map a Klip layer onto an opencut element.
/// All times in `f64` seconds; the seconds-to-`MediaTime` conversion
/// happens in the wasm binding / TS, never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrandMapCtx {
    pub canvas_width: f64,
    pub canvas_height: f64,
    pub total_duration: f64,
    pub asset_width: Option<f64>,
    pub asset_height: Option<f64>,
}

/// Platform-neutral mapped element. The wasm binding (Task 6) converts
/// `start_sec`/`duration_sec` into `MediaTime` and `target_track` into
/// the opencut track id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MappedElement {
    pub target_track: BrandTrack,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub pos_x: f64,
    pub pos_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotate_deg: f64,
    pub opacity: f64,
    pub hidden: bool,
    pub volume_db: Option<f64>,
    pub duck: bool,
    pub z: i32,
    pub trim_start_sec: f64,
    pub trim_end_sec: f64,
}

/// Reverse patch produced by `element_to_klip_layer_patch`: Klip-space
/// fields the panel (Task 7) writes back onto the stored layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct KlipLayerPatch {
    pub full: bool,
    pub anchor: BrandAnchor,
    pub fit: BrandFit,
    pub start: f64,
    pub dur: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotate: f64,
    pub opacity: f64,
    pub enabled: bool,
    pub volume: f64,
    pub duck: bool,
    pub z: i32,
}

pub fn gain_to_db(gain: f64) -> f64 {
    let db = 20.0 * gain.max(MIN_LINEAR_GAIN).log10();
    db.clamp(VOLUME_DB_MIN, VOLUME_DB_MAX)
}

pub fn db_to_gain(db: f64) -> f64 {
    10_f64.powf(db.clamp(VOLUME_DB_MIN, VOLUME_DB_MAX) / 20.0)
}

pub fn klip_layer_to_element(layer: &KlipBrandLayer, ctx: &BrandMapCtx) -> MappedElement {
    let target_track = match layer.kind {
        KlipBrandKind::Image => BrandTrack::Graphic,
        KlipBrandKind::Video => BrandTrack::Video,
        KlipBrandKind::Audio => BrandTrack::Audio,
    };

    let (start_sec, duration_sec) = if layer.full {
        (0.0, ctx.total_duration)
    } else {
        (layer.start, layer.dur)
    };

    let pos_x = (layer.x - 0.5) * ctx.canvas_width;
    let pos_y = (0.5 - layer.y) * ctx.canvas_height;

    // FullWidth: lebar tepat selebar kanvas, tinggi mengikuti rasio asli
    // (boleh melewati kanvas). Free: skala manual dikali lebar kanvas.
    let base_scale = match ctx.asset_width {
        Some(w) if w > 0.0 && layer.fit == BrandFit::FullWidth => ctx.canvas_width / w,
        Some(w) if w > 0.0 => layer.scale * ctx.canvas_width / w,
        _ => layer.scale,
    };
    let clamped_scale = base_scale.max(MIN_TRANSFORM_SCALE);

    let rotate_deg = layer.rotate.clamp(-360.0, 360.0);
    let opacity = layer.opacity / 100.0;

    let volume_db = match layer.kind {
        KlipBrandKind::Audio => Some(gain_to_db(layer.volume)),
        _ => None,
    };

    MappedElement {
        target_track,
        start_sec,
        duration_sec,
        pos_x,
        pos_y,
        scale_x: clamped_scale,
        scale_y: clamped_scale,
        rotate_deg,
        opacity,
        hidden: !layer.enabled,
        volume_db,
        duck: layer.duck,
        z: layer.z,
        trim_start_sec: 0.0,
        trim_end_sec: 0.0,
    }
}

pub fn element_to_klip_layer_patch(el: &MappedElement, ctx: &BrandMapCtx) -> KlipLayerPatch {
    let base_scale = match ctx.asset_width {
        Some(w) if w > 0.0 && ctx.canvas_width > 0.0 => {
            // Invert `scale * canvasWidth / assetWidth`, averaging the axes
            // so a panel that edits scale_x/scale_y independently still
            // round-trips through the single Klip `scale` field.
            let avg = (el.scale_x + el.scale_y) / 2.0;
            avg * w / ctx.canvas_width
        }
        _ => (el.scale_x + el.scale_y) / 2.0,
    };

    let (full, start, dur) = if el.start_sec == 0.0 && el.duration_sec == ctx.total_duration {
        (true, 0.0, 0.0)
    } else {
        (false, el.start_sec, el.duration_sec)
    };

    KlipLayerPatch {
        full,
        // Dari elemen saja niat user tidak terbaca; Start/Free adalah default
        // netral. Panel brand mempertahankan pilihan dari layer tersimpan.
        anchor: BrandAnchor::Start,
        fit: BrandFit::Free,
        start,
        dur,
        x: if ctx.canvas_width > 0.0 {
            el.pos_x / ctx.canvas_width + 0.5
        } else {
            0.5
        },
        y: if ctx.canvas_height > 0.0 {
            0.5 - el.pos_y / ctx.canvas_height
        } else {
            0.5
        },
        scale: base_scale,
        rotate: el.rotate_deg.clamp(-360.0, 360.0),
        opacity: el.opacity * 100.0,
        enabled: !el.hidden,
        volume: match el.target_track {
            BrandTrack::Audio => el.volume_db.map(db_to_gain).unwrap_or(DEFAULT_VOLUME),
            _ => DEFAULT_VOLUME,
        },
        duck: el.duck,
        z: el.z,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn ctx() -> BrandMapCtx {
        BrandMapCtx {
            canvas_width: 1080.0,
            canvas_height: 1920.0,
            total_duration: 55.8,
            asset_width: Some(540.0),
            asset_height: Some(200.0),
        }
    }

    #[test]
    fn full_image_maps_to_graphic_track() {
        let layer = KlipBrandLayer {
            kind: KlipBrandKind::Image,
            full: true,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_eq!(el.target_track, BrandTrack::Graphic);
        assert_eq!(el.start_sec, 0.0);
        assert_eq!(el.duration_sec, 55.8);
    }

    #[test]
    fn timed_layer_uses_start_dur_directly() {
        let layer = KlipBrandLayer {
            kind: KlipBrandKind::Video,
            full: false,
            start: 2.5,
            dur: 10.0,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_eq!(el.target_track, BrandTrack::Video);
        assert_relative_eq!(el.start_sec, 2.5);
        assert_relative_eq!(el.duration_sec, 10.0);
    }

    #[test]
    fn audio_maps_gain_to_db_and_targets_audio_track() {
        // gain 1.0 -> 0 dB exactly
        let layer = KlipBrandLayer {
            kind: KlipBrandKind::Audio,
            full: true,
            volume: 1.0,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_eq!(el.target_track, BrandTrack::Audio);
        assert_relative_eq!(el.volume_db.unwrap(), 0.0);

        // gain 0.35 (Klip default) -> 20*log10(0.35) ~= -9.1186 dB
        let layer = KlipBrandLayer {
            volume: 0.35,
            ..layer
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_relative_eq!(el.volume_db.unwrap(), 20.0 * 0.35_f64.log10());

        // gain 0 clamps to MIN_LINEAR_GAIN -> VOLUME_DB_MIN
        let layer = KlipBrandLayer {
            volume: 0.0,
            ..layer
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_relative_eq!(el.volume_db.unwrap(), VOLUME_DB_MIN);
    }

    #[test]
    fn disabled_layer_maps_to_hidden() {
        let layer = KlipBrandLayer {
            enabled: false,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert!(el.hidden);
        let patch = element_to_klip_layer_patch(&el, &ctx());
        assert!(!patch.enabled);
    }

    #[test]
    fn position_scale_opacity_rotate_follow_scale_contract() {
        let layer = KlipBrandLayer {
            x: 0.06,
            y: 0.05,
            scale: 0.36,
            rotate: 45.0,
            opacity: 80.0,
            ..Default::default()
        };
        let c = ctx();
        let el = klip_layer_to_element(&layer, &c);
        // posX = (0.06-0.5)*1080 = -475.2; posY = (0.5-0.05)*1920 = 864
        assert_relative_eq!(el.pos_x, -475.2);
        assert_relative_eq!(el.pos_y, 864.0);
        // scaleX = scaleY = 0.36 * 1080 / 540 = 0.72
        assert_relative_eq!(el.scale_x, 0.72);
        assert_relative_eq!(el.scale_y, 0.72);
        assert_relative_eq!(el.opacity, 0.8);
        assert_relative_eq!(el.rotate_deg, 45.0);
    }


    #[test]
    fn full_width_ignores_scale_and_fills_canvas_width() {
        let layer = KlipBrandLayer {
            // scale sengaja kecil; harus diabaikan saat FullWidth.
            scale: 0.1,
            fit: BrandFit::FullWidth,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        // scaleX = canvas_width / asset_width = 1080 / 540 = 2
        assert_relative_eq!(el.scale_x, 2.0);
        // Tinggi memakai skala sama: 200 * 2 = 400, bukan dipaksa 1920.
        assert_relative_eq!(el.scale_y, 2.0);
        assert_relative_eq!(540.0 * el.scale_x, 1080.0);
        assert_relative_eq!(200.0 * el.scale_y, 400.0);
    }

    #[test]
    fn free_fit_still_uses_manual_scale() {
        let layer = KlipBrandLayer {
            scale: 0.36,
            fit: BrandFit::Free,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_relative_eq!(el.scale_x, 0.72);
    }

    #[test]
    fn scale_falls_back_without_asset_width_and_clamps_minimum() {
        let c = BrandMapCtx {
            asset_width: None,
            ..ctx()
        };
        let layer = KlipBrandLayer {
            scale: 0.5,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &c);
        assert_relative_eq!(el.scale_x, 0.5);

        // tiny scale clamps to MIN_TRANSFORM_SCALE
        let layer = KlipBrandLayer {
            scale: 0.0001,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &c);
        assert_relative_eq!(el.scale_x, MIN_TRANSFORM_SCALE);
    }

    #[test]
    fn rotate_clamps_to_360_range() {
        let layer = KlipBrandLayer {
            rotate: 720.0,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_relative_eq!(el.rotate_deg, 360.0);

        let layer = KlipBrandLayer {
            rotate: -500.0,
            ..Default::default()
        };
        let el = klip_layer_to_element(&layer, &ctx());
        assert_relative_eq!(el.rotate_deg, -360.0);
    }

    #[test]
    fn round_trip_layer_element_layer_is_identical_except_id() {
        // Timed (full=false) layer so every field survives the mapping.
        let layer = KlipBrandLayer {
            id: "layer_1".to_string(),
            kind: KlipBrandKind::Image,
            enabled: true,
            x: 0.25,
            y: 0.75,
            scale: 0.5,
            rotate: -30.0,
            opacity: 90.0,
            full: false,
            anchor: BrandAnchor::Start,
            fit: BrandFit::Free,
            start: 1.5,
            dur: 12.0,
            volume: 0.35,
            duck: true,
            z: 3,
        };
        let c = ctx();
        let el = klip_layer_to_element(&layer, &c);
        let patch = element_to_klip_layer_patch(&el, &c);
        assert_eq!(patch.full, layer.full);
        assert_relative_eq!(patch.start, layer.start);
        assert_relative_eq!(patch.dur, layer.dur);
        assert_relative_eq!(patch.x, layer.x);
        assert_relative_eq!(patch.y, layer.y);
        assert_relative_eq!(patch.scale, layer.scale);
        assert_relative_eq!(patch.rotate, layer.rotate);
        assert_relative_eq!(patch.opacity, layer.opacity);
        assert_eq!(patch.enabled, layer.enabled);
        assert_relative_eq!(patch.volume, layer.volume);
        assert_eq!(patch.duck, layer.duck);
        assert_eq!(patch.z, layer.z);
    }

    #[test]
    fn round_trip_full_audio_layer() {
        let layer = KlipBrandLayer {
            id: "layer_audio".to_string(),
            kind: KlipBrandKind::Audio,
            enabled: true,
            full: true,
            start: 7.0, // ignored while full=true
            dur: 9.0,   // ignored while full=true
            volume: 2.0,
            duck: true,
            z: 1,
            ..Default::default()
        };
        let c = ctx();
        let el = klip_layer_to_element(&layer, &c);
        // gain 2.0 -> 20*log10(2) ~= 6.02 dB
        assert_relative_eq!(el.volume_db.unwrap(), 20.0 * 2_f64.log10());
        let patch = element_to_klip_layer_patch(&el, &c);
        assert!(patch.full);
        assert_relative_eq!(patch.volume, 2.0);
        assert_eq!(patch.duck, layer.duck);
        assert_eq!(patch.z, layer.z);
        assert_eq!(patch.enabled, layer.enabled);
    }
}
