/// Anchor waktu layer template terhadap video utama. Cermin TS:
/// apps/web/src/klip/template-resolve.ts (dibuat Task 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateAnchor {
    Start,
    MainEnd,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemplateLayerInput {
    pub anchor: TemplateAnchor,
    pub full: bool,
    pub start: f64,
    pub dur: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedLayer {
    pub start: f64,
    pub dur: f64,
}

/// full -> 0..main; Start -> apa adanya (tidak pernah skip/clamp);
/// MainEnd -> main_duration + start (start boleh negatif untuk outro di dalam video).
pub fn resolve_template_layer(layer: &TemplateLayerInput, main_duration: f64) -> ResolvedLayer {
    if layer.full {
        return ResolvedLayer { start: 0.0, dur: main_duration };
    }
    match layer.anchor {
        TemplateAnchor::Start => ResolvedLayer { start: layer.start, dur: layer.dur },
        TemplateAnchor::MainEnd => ResolvedLayer { start: main_duration + layer.start, dur: layer.dur },
    }
}

/// Durasi total project = max(durasi utama, ujung layer terjauh).
pub fn resolve_total_duration(main_duration: f64, layers: &[ResolvedLayer]) -> f64 {
    layers.iter().fold(main_duration, |acc, l| acc.max(l.start + l.dur))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_layer_spans_main_duration() {
        let layer = TemplateLayerInput { anchor: TemplateAnchor::Start, full: true, start: 99.0, dur: 99.0 };
        let r = resolve_template_layer(&layer, 50.0);
        assert_eq!(r.start, 0.0);
        assert_eq!(r.dur, 50.0);
    }

    #[test]
    fn fixed_slot_passes_through_untouched() {
        let layer = TemplateLayerInput { anchor: TemplateAnchor::Start, full: false, start: 120.0, dur: 30.0 };
        let r = resolve_template_layer(&layer, 50.0);
        assert_eq!(r.start, 120.0);
        assert_eq!(r.dur, 30.0);
    }

    #[test]
    fn main_end_anchor_offsets_from_main_duration() {
        let layer = TemplateLayerInput { anchor: TemplateAnchor::MainEnd, full: false, start: 0.1, dur: 20.0 };
        let r = resolve_template_layer(&layer, 50.0);
        assert!((r.start - 50.1).abs() < 1e-9);
        assert_eq!(r.dur, 20.0);
    }

    #[test]
    fn total_duration_extends_for_appended_ads() {
        let layers = vec![
            ResolvedLayer { start: 0.0, dur: 50.0 },
            ResolvedLayer { start: 50.1, dur: 20.0 },
        ];
        assert!((resolve_total_duration(50.0, &layers) - 70.1).abs() < 1e-9);
    }
}
