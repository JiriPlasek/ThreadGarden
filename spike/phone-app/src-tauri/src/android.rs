//! JNI between the Kotlin foreground service and the core.
use jni::objects::{GlobalRef, JClass, JString, JValue};
use jni::{JNIEnv, JavaVM};
use std::sync::OnceLock;

static VM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();

fn call(method: &str, a: &str, b: &str) {
    let (Some(vm), Some(class)) = (VM.get(), CLASS.get()) else { return };
    let Ok(mut env) = vm.attach_current_thread_permanently() else { return };
    let (Ok(ja), Ok(jb)) = (env.new_string(a), env.new_string(b)) else { return };
    let cls: &JClass = class.as_obj().into();
    let _ = env.call_static_method(cls, method, "(Ljava/lang/String;Ljava/lang/String;)V",
        &[JValue::Object(&ja), JValue::Object(&jb)]);
    let _ = env.exception_clear();
}

#[no_mangle]
pub extern "system" fn Java_dev_threadgarden_spike_CoreService_startCore(
    mut env: JNIEnv, class: JClass, data_dir: JString,
) {
    if let Ok(vm) = env.get_java_vm() { let _ = VM.set(vm); }
    if let Ok(g) = env.new_global_ref(&class) { let _ = CLASS.set(g); }
    let dir: String = env.get_string(&data_dir).map(|s| s.into()).unwrap_or_default();
    let _ = crate::core::ALERT.set(Box::new(|t, b| call("postAlert", t, b)));
    let _ = crate::core::STATUS.set(Box::new(|t, b| call("postStatus", t, b)));
    crate::core::start(dir);
}

#[no_mangle]
pub extern "system" fn Java_dev_threadgarden_spike_CoreService_networkChanged(_e: JNIEnv, _c: JClass) {
    crate::core::network_changed();
}
