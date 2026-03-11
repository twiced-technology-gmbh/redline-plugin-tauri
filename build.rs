fn main() {
    println!("cargo::rerun-if-changed=src/js/fabric.min.js");
    println!("cargo::rerun-if-changed=src/js/annotation-overlay.js");

    let fabric = std::fs::read_to_string("src/js/fabric.min.js")
        .expect("Failed to read fabric.min.js");
    let overlay = std::fs::read_to_string("src/js/annotation-overlay.js")
        .expect("Failed to read annotation-overlay.js");
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let bundle = format!("{}\n{}", fabric, overlay);
    std::fs::write(format!("{}/redline-bundle.js", out_dir), bundle)
        .expect("Failed to write redline-bundle.js");

    tauri_plugin::Builder::new(&["capture_screenshot"]).build();
}
