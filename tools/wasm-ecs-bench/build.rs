fn main() {
    // wasm-bindgen's threading transform needs this symbol on newer linkers.
    // Keep this leaf-only so adding the export does not rebuild dependencies.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=--export=__heap_base");
    }
}
