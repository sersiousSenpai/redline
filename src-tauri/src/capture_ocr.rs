// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Local screenshot OCR using the OS-provided Apple Vision text recognizer.
//! No model download, subprocess, network request, or desktop UI is involved.
//! `recognize_png*` is synchronous: call only from a bounded background worker.
//! A five-second watchdog requests cancellation; Vision cancellation is
//! cooperative, so this is not represented as a hard native execution deadline.
//!
//! API contract checked against the installed macOS SDK's Vision headers:
//! VNRecognizeTextRequest.h, VNRequestHandler.h, VNRequest.h, VNObservation.h.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

pub const EXTRACTOR_VERSION: &str = "redline-apple-vision-ocr-v1";
pub const MAX_TEXT_BYTES: usize = 8_000;
pub const MAX_REGIONS: usize = 256;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const MAX_IMAGE_SIDE: u32 = 8_192;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrBounds {
    /// Normalized image coordinates, with a top-left origin.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRegion {
    pub text: String,
    pub confidence: f64,
    pub bounds: OcrBounds,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    /// Mean candidate confidence, weighted by retained text length. This is an
    /// OCR quality signal, never confidence in the truth of a source's claims.
    pub confidence: f64,
    pub extractor_version: String,
    /// Actual Vision request revision and OS version, not a guessed model ID.
    pub model_version: String,
    pub regions: Vec<OcrRegion>,
    pub truncated: bool,
}

/// Reject oversized pixel grids before ImageIO/Vision allocates their pixels.
/// This is an admission check, not a PNG decoder; ImageIO validates the image.
fn validate_png(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("OCR image exceeds the 8 MiB input limit".into());
    }
    if bytes.len() < 33
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || bytes[8..12] != 13_u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return Err("OCR requires a PNG image with a complete IHDR header".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0
        || height == 0
        || width > MAX_IMAGE_SIDE
        || height > MAX_IMAGE_SIDE
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return Err("OCR image dimensions exceed 16 megapixels or an 8192-pixel side".into());
    }
    Ok((width, height))
}

fn bounded_text(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn image_bounds(x: f64, y: f64, width: f64, height: f64) -> Option<OcrBounds> {
    if [x, y, width, height].iter().any(|value| !value.is_finite()) || width <= 0.0 || height <= 0.0
    {
        return None;
    }
    let left = x.clamp(0.0, 1.0);
    let right = (x + width).clamp(0.0, 1.0);
    let top = (1.0 - y - height).clamp(0.0, 1.0);
    let bottom = (1.0 - y).clamp(0.0, 1.0);
    (right > left && bottom > top).then_some(OcrBounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

fn assemble(mut regions: Vec<OcrRegion>, model_version: String, mut truncated: bool) -> OcrResult {
    // Vision observations need not be in reading order. Ordering is geometric;
    // columns and document meaning are deliberately not inferred from boxes.
    regions.sort_by(|a, b| {
        a.bounds
            .y
            .total_cmp(&b.bounds.y)
            .then_with(|| a.bounds.x.total_cmp(&b.bounds.x))
    });
    let mut text = String::new();
    let mut retained = Vec::new();
    let mut weighted = 0.0;
    let mut weight = 0;
    for mut region in regions {
        let separator = usize::from(!text.is_empty());
        let available = MAX_TEXT_BYTES.saturating_sub(text.len() + separator);
        if available == 0 || retained.len() >= MAX_REGIONS {
            truncated = true;
            break;
        }
        let clean = region.text.trim();
        if clean.is_empty() {
            continue;
        }
        if clean.len() > available {
            truncated = true;
        }
        region.text = bounded_text(clean, available);
        if region.text.is_empty() {
            truncated = true;
            break;
        }
        region.confidence = if region.confidence.is_finite() {
            region.confidence.clamp(0.0, 1.0)
        } else {
            0.0
        };
        if separator != 0 {
            text.push('\n');
        }
        text.push_str(&region.text);
        weighted += region.confidence * region.text.len() as f64;
        weight += region.text.len();
        retained.push(region);
    }
    OcrResult {
        text,
        confidence: if weight == 0 {
            0.0
        } else {
            weighted / weight as f64
        },
        extractor_version: EXTRACTOR_VERSION.into(),
        model_version,
        regions: retained,
        truncated,
    }
}

pub fn recognize_png(bytes: &[u8]) -> Result<OcrResult, String> {
    recognize_png_with_cancel(bytes, &AtomicBool::new(false))
}

pub fn recognize_png_with_cancel(
    bytes: &[u8],
    cancelled: &AtomicBool,
) -> Result<OcrResult, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("OCR was cancelled before recognition".into());
    }
    validate_png(bytes)?;
    #[cfg(target_os = "macos")]
    {
        native::recognize(bytes, cancelled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Local Apple Vision OCR is unavailable on this platform".into())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::{
        msg_send,
        rc::{autoreleasepool, Allocated, Retained},
        runtime::{AnyClass, AnyObject, Bool},
    };
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSData, NSDictionary, NSError, NSProcessInfo, NSRect, NSString,
    };
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    #[link(name = "Vision", kind = "framework")]
    unsafe extern "C" {
        // A real exported symbol also keeps Vision linked when the classes
        // themselves are discovered through the Objective-C runtime.
        static VNErrorDomain: *const AnyObject;
    }

    pub(super) fn recognize(bytes: &[u8], cancelled: &AtomicBool) -> Result<OcrResult, String> {
        if MainThreadMarker::new().is_some() {
            return Err(
                "OCR must run on a background worker, never the application main thread".into(),
            );
        }
        autoreleasepool(|_| unsafe {
            if VNErrorDomain.is_null() {
                return Err("The Apple Vision framework is unavailable".into());
            }
            let request_class = AnyClass::get(c"VNRecognizeTextRequest")
                .ok_or("Apple Vision text recognition is unavailable")?;
            let handler_class = AnyClass::get(c"VNImageRequestHandler")
                .ok_or("Apple Vision image processing is unavailable")?;
            // SAFETY: These selectors and their exact argument/result types
            // are declared by the SDK headers referenced at the module top.
            // All owning objects remain in this worker's autorelease pool.
            let request: Option<Retained<AnyObject>> = msg_send![request_class, new];
            let request = request.ok_or("Apple Vision could not create an OCR request")?;
            let _: () = msg_send![&*request, setRecognitionLevel: 0_isize]; // accurate
            let _: () = msg_send![&*request, setUsesLanguageCorrection: Bool::YES];
            let _: () = msg_send![&*request, setPreferBackgroundProcessing: Bool::YES];
            let _: () = msg_send![&*request, setMinimumTextHeight: 0.005_f32];
            let revision: usize = msg_send![&*request, revision];
            if revision >= 3 {
                let _: () = msg_send![&*request, setAutomaticallyDetectsLanguage: Bool::YES];
            }
            let model_version = format!(
                "Apple Vision VNRecognizeTextRequest revision {revision}; {}",
                NSProcessInfo::processInfo().operatingSystemVersionString()
            );
            let data = NSData::with_bytes(bytes);
            let options = NSDictionary::<NSString, AnyObject>::new();
            let allocated: Allocated<AnyObject> = msg_send![handler_class, alloc];
            let handler: Option<Retained<AnyObject>> =
                msg_send![allocated, initWithData: &*data, options: &*options];
            let handler = handler.ok_or("Apple Vision could not decode the PNG image")?;
            let requests = NSArray::from_slice(&[&*request]);
            let timed_out = AtomicBool::new(false);
            let (done_tx, done_rx) = mpsc::channel::<()>();
            let request_address = Retained::as_ptr(&request) as usize;
            // VNRequest::cancel is the API for interrupting an executing
            // synchronous performRequests call. Only that selector crosses
            // threads. The request is retained until the scoped watcher joins.
            let (ok, error) = std::thread::scope(|scope| {
                let timed_out_ref = &timed_out;
                scope.spawn(move || {
                    autoreleasepool(|_| {
                        let deadline = Instant::now() + Duration::from_secs(5);
                        loop {
                            match done_rx.recv_timeout(Duration::from_millis(25)) {
                                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                            }
                            if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                                timed_out_ref
                                    .store(!cancelled.load(Ordering::Acquire), Ordering::Release);
                                let request = request_address as *const AnyObject;
                                let _: () = msg_send![request, cancel];
                                break;
                            }
                        }
                    })
                });
                let mut error: *mut NSError = std::ptr::null_mut();
                let ok: Bool = msg_send![&*handler, performRequests: &*requests, error: &mut error];
                let _ = done_tx.send(());
                // Retain the autoreleased NSError before leaving this scope.
                (ok.as_bool(), Retained::retain(error))
            });
            if cancelled.load(Ordering::Acquire) {
                return Err("OCR was cancelled during recognition".into());
            }
            if timed_out.load(Ordering::Acquire) {
                return Err(
                    "OCR exceeded its five-second processing budget and requested cancellation"
                        .into(),
                );
            }
            if !ok {
                return Err(error
                    .map(|error| {
                        format!("Apple Vision OCR failed: {}", error.localizedDescription())
                    })
                    .unwrap_or_else(|| {
                        "Apple Vision OCR failed without an error description".into()
                    }));
            }
            let observations: Option<Retained<NSArray<AnyObject>>> = msg_send![&*request, results];
            let Some(observations) = observations else {
                return Err("Apple Vision completed without a results collection".into());
            };
            let mut regions = Vec::new();
            let mut truncated = observations.len() > MAX_REGIONS;
            for index in 0..observations.len().min(MAX_REGIONS) {
                let observation = observations.objectAtIndex(index);
                let candidates: Retained<NSArray<AnyObject>> =
                    msg_send![&*observation, topCandidates: 1_usize];
                if candidates.is_empty() {
                    continue;
                }
                let candidate = candidates.objectAtIndex(0);
                let text: Retained<NSString> = msg_send![&*candidate, string];
                let confidence: f32 = msg_send![&*candidate, confidence];
                let rect: NSRect = msg_send![&*observation, boundingBox];
                let Some(bounds) = image_bounds(
                    rect.origin.x,
                    rect.origin.y,
                    rect.size.width,
                    rect.size.height,
                ) else {
                    continue;
                };
                let text = text.to_string();
                truncated |= text.len() > MAX_TEXT_BYTES;
                regions.push(OcrRegion {
                    text: bounded_text(&text, MAX_TEXT_BYTES),
                    confidence: confidence as f64,
                    bounds,
                });
            }
            Ok(assemble(regions, model_version, truncated))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const IMAGE: &[u8] = include_bytes!("../../fixtures/mission/ocr-reference.png");

    #[test]
    fn image_admission_rejects_empty_corrupt_and_unbounded_pixel_grids() {
        assert!(validate_png(&[]).is_err());
        assert!(validate_png(b"not a PNG").is_err());
        let mut bytes = IMAGE.to_vec();
        bytes[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(validate_png(&bytes).is_err());
        assert!(validate_png(&vec![0; MAX_IMAGE_BYTES + 1]).is_err());
        assert!(recognize_png_with_cancel(IMAGE, &AtomicBool::new(true))
            .unwrap_err()
            .contains("cancelled"));
    }

    #[test]
    fn bounds_and_utf8_outputs_are_normalized_and_bounded() {
        let bounds = image_bounds(0.1, 0.7, 0.5, 0.2).unwrap();
        assert!((bounds.y - 0.1).abs() < 0.0001);
        assert!(image_bounds(f64::NAN, 0.0, 1.0, 1.0).is_none());
        assert!(image_bounds(2.0, 0.0, 0.2, 0.2).is_none());
        let result = assemble(
            vec![OcrRegion {
                text: "界".repeat(4_000),
                confidence: f64::NAN,
                bounds,
            }],
            "fixture".into(),
            false,
        );
        assert!(result.text.len() <= MAX_TEXT_BYTES);
        assert!(result.truncated);
        assert_eq!(result.confidence, 0.0);
        assert_eq!(result.text, result.regions[0].text);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "mandatory isolated CI step; Vision cold start must not contend with the parallel database suite"]
    fn vision_recognizes_local_text_image() {
        let result = recognize_png(IMAGE)
            .expect("Apple Vision must recognize the bundled synthetic PNG locally");
        assert!(
            result.text.to_uppercase().contains("SECURITIES REVIEW"),
            "OCR missed the fixture heading: {:?}",
            result.text
        );
        assert!(result.text.contains("2026"));
        assert!(!result.regions.is_empty());
        assert!(result.confidence > 0.5);
        assert!(result.model_version.contains("revision"));
        assert!(result.regions.iter().all(|region| region.bounds.x >= 0.0
            && region.bounds.y >= 0.0
            && region.bounds.x + region.bounds.width <= 1.0001
            && region.bounds.y + region.bounds.height <= 1.0001));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vision_rejects_corrupt_png_payload() {
        let mut corrupt = IMAGE[..33].to_vec();
        corrupt.extend_from_slice(b"invalid compressed image data");
        let error = recognize_png(&corrupt).unwrap_err();
        assert!(
            error.contains("Apple Vision"),
            "corrupt input must fail native decoding, not the processing budget: {error}"
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn unsupported_platform_reports_unavailability() {
        assert!(recognize_png(IMAGE).unwrap_err().contains("unavailable"));
    }

    /// Synthetic-only measurement; run the compiled test binary under time -l
    /// to compare process CPU/RSS without counting compilation or Cargo.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "100-sample local OCR performance measurement"]
    fn ocr_fixture_microbenchmark() {
        let disabled = std::env::var("REDLINE_OCR_BENCH_MODE").as_deref() == Ok("disabled");
        let count = std::env::var("REDLINE_OCR_BENCH_ITERATIONS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(100)
            .clamp(1, 100);
        let start = std::time::Instant::now();
        let cold = if disabled {
            None
        } else {
            Some(recognize_png(std::hint::black_box(IMAGE)))
        };
        let cold_ms = start.elapsed().as_secs_f64() * 1000.0;
        let mut samples = Vec::with_capacity(count);
        let mut failures = 0;
        let mut recognized_regions = 0;
        let mut output_bytes = 0;
        let mut model_version = String::new();
        for _ in 0..count {
            let start = std::time::Instant::now();
            if !disabled {
                match recognize_png(std::hint::black_box(IMAGE)) {
                    Ok(result) => {
                        recognized_regions += result.regions.len();
                        output_bytes = serde_json::to_vec(&result).unwrap().len();
                        model_version = result.model_version;
                    }
                    Err(_) => failures += 1,
                }
            } else {
                std::hint::black_box(IMAGE.len());
            }
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let percentile = |p: f64| {
            samples[((samples.len() as f64 * p).ceil() as usize)
                .saturating_sub(1)
                .min(samples.len() - 1)]
        };
        println!(
            "{}",
            serde_json::json!({"mode":if disabled {"disabled"} else {"enabled"},"samples":count,"coldMs":cold_ms,"coldSucceeded":cold.as_ref().map(|result| result.is_ok()),"p50Ms":percentile(0.50),"p75Ms":percentile(0.75),"p95Ms":percentile(0.95),"inputPngBytes":IMAGE.len(),"outputBytes":output_bytes,"recognizedRegions":recognized_regions,"errors":failures,"extractorVersion":EXTRACTOR_VERSION,"modelVersion":model_version})
        );
    }
}
