fn main() {
    // wasm-bindgen's threading transform needs this symbol on newer linkers.
    // Keep this leaf-only so adding the export does not rebuild dependencies.
    println!("cargo:rustc-link-arg=--export=__heap_base");
    println!("cargo:rustc-env=BENCH_OPT_LEVEL={}", std::env::var("OPT_LEVEL").unwrap());
}
