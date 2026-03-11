use tauri::{command, plugin::Builder as PluginBuilder, plugin::TauriPlugin, Runtime, Webview};

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::NSDictionary;
    use objc2_web_kit::WKWebView;
    use block2::RcBlock;
    use base64::Engine;

    pub fn take_screenshot(
        wk_webview_ptr: *mut std::ffi::c_void,
        tx: std::sync::mpsc::SyncSender<Result<String, String>>,
    ) {
        unsafe {
            let wk_webview: &WKWebView = &*(wk_webview_ptr as *const WKWebView);

            let block = RcBlock::new(move |image: *mut NSImage, _error: *mut objc2_foundation::NSError| {
                let result = image_to_jpeg_data_url(image);
                let _ = tx.send(result);
            });

            wk_webview.takeSnapshotWithConfiguration_completionHandler(None, &block);
        }
    }

    unsafe fn image_to_jpeg_data_url(ns_image: *mut NSImage) -> Result<String, String> {
        if ns_image.is_null() {
            return Err("Screenshot returned null image".into());
        }
        let image = &*ns_image;

        let tiff_data = image
            .TIFFRepresentation()
            .ok_or("Failed to get TIFF data")?;

        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff_data)
            .ok_or("Failed to create bitmap rep")?;

        let properties = NSDictionary::new();
        let jpeg_data = bitmap
            .representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
            .ok_or("Failed to convert to JPEG")?;

        let bytes = jpeg_data.as_bytes_unchecked();
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:image/jpeg;base64,{}", b64))
    }
}

#[command]
async fn capture_screenshot<R: Runtime>(webview: Webview<R>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        webview
            .with_webview(move |platform_webview| {
                macos::take_screenshot(platform_webview.inner(), tx);
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Screenshot not supported on this platform — using fallback".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R>::new("redline")
        .js_init_script(
            include_str!(concat!(env!("OUT_DIR"), "/redline-bundle.js")).to_string(),
        )
        .invoke_handler(tauri::generate_handler![capture_screenshot])
        .build()
}
