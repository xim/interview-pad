// Linked into every C/C++ program (as main.c's or main.cpp's language) by clang.worker.ts.
// - UBSan handlers: the sysroot has no sanitizer runtime, so report "file:line:col: runtime error" here.
//   Built with -fno-sanitize-recover=all, so only the noreturn variants are needed. Exact arities matter:
//   on WASM a signature mismatch links to a trapping stub instead of failing.
// - Crash helpers exported for wasi.worker.ts.
#pragma clang diagnostic ignored "-Weverything"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#ifdef __cplusplus
#define EXTERN_C extern "C"
#else
#define EXTERN_C
#endif

#define NO_UBSAN __attribute__((no_sanitize("undefined")))

struct ubsan_loc {
    const char* file;
    uint32_t line, column;
};

struct ubsan_type {
    uint16_t kind, info;
    char name[];
};

// Every handler's data struct starts with the source location.
NO_UBSAN __attribute__((noreturn)) static void report(const struct ubsan_loc* loc, const char* what) {
    fflush(stdout);
    fprintf(stderr, "%s:%u:%u: runtime error: %s\n", loc->file, loc->line, loc->column, what);
    abort();
}

#define H(name, msg, ...)                                                                    \
    EXTERN_C NO_UBSAN __attribute__((noreturn)) void __ubsan_handle_##name(void* data, ##__VA_ARGS__) { \
        report((const struct ubsan_loc*)data, msg);                                          \
    }
#define V uintptr_t

H(add_overflow_abort, "signed integer overflow", V, V)
H(sub_overflow_abort, "signed integer overflow", V, V)
H(mul_overflow_abort, "signed integer overflow", V, V)
H(negate_overflow_abort, "signed integer overflow (negation)", V)
H(divrem_overflow_abort, "division by zero or signed overflow", V, V)
H(shift_out_of_bounds_abort, "shift amount out of range or shifted value overflows", V, V)
H(out_of_bounds_abort, "array index out of bounds", V)
H(pointer_overflow_abort, "pointer arithmetic overflow", V, V)
H(load_invalid_value_abort, "load of invalid value (bool or enum out of range)", V)
H(float_cast_overflow_abort, "floating-point value out of range for the target type", V)
H(vla_bound_not_positive_abort, "variable-length array bound is not positive", V)
H(alignment_assumption_abort, "alignment assumption violated", V, V, V)
H(implicit_conversion_abort, "implicit conversion changed the value", V, V)
H(invalid_builtin_abort, "invalid argument to builtin (e.g. __builtin_clz(0))")
H(nonnull_arg_abort, "null passed as an argument declared nonnull")
H(nonnull_return_v1_abort, "null returned from a function declared returns_nonnull", V)
H(function_type_mismatch_abort, "call through a function pointer of the wrong type", V)
H(dynamic_type_cache_miss_abort, "object has the wrong dynamic type", V, V)
H(builtin_unreachable, "execution reached __builtin_unreachable()")
H(missing_return, "control reached the end of a value-returning function")

struct type_mismatch_data {
    struct ubsan_loc loc;
    const struct ubsan_type* type;
    unsigned char log_alignment, kind;
};

EXTERN_C NO_UBSAN __attribute__((noreturn)) void __ubsan_handle_type_mismatch_v1_abort(void* data, V ptr) {
    const struct type_mismatch_data* d = (const struct type_mismatch_data*)data;
    // as compiler-rt's ubsan_handlers.cpp (TypeCheckKinds), whose report wording this mirrors
    static const char* const kinds[] = {"load of", "store to", "reference binding to", "member access within",
                                        "member call on", "constructor call on", "downcast of", "downcast of",
                                        "upcast of", "cast to virtual base of", "_Nonnull binding to",
                                        "dynamic operation on"};
    const char* kind = d->kind < sizeof kinds / sizeof *kinds ? kinds[d->kind] : "access of";
    char what[256];
    if (!ptr)
        snprintf(what, sizeof what, "%s null pointer of type %s", kind, d->type->name);
    else if (d->log_alignment && ptr & ((1u << d->log_alignment) - 1))
        snprintf(what, sizeof what, "%s misaligned address %p of type %s", kind, (void*)ptr, d->type->name);
    else
        snprintf(what, sizeof what, "%s address %p with insufficient space for type %s", kind, (void*)ptr, d->type->name);
    report(&d->loc, what);
}

// Called by wasi.worker.ts after a crash, so buffered output isn't lost.
EXTERN_C __attribute__((export_name("__ip_flush"))) void __ip_flush(void) { fflush(NULL); }

#if defined(__cplusplus) && defined(__cpp_exceptions)
#include <exception>
#include <typeinfo>

extern "C" void* __cxa_begin_catch(void*) noexcept;
extern "C" std::type_info* __cxa_current_exception_type();
extern "C" char* __cxa_demangle(const char*, char*, size_t*, int*);

// With wasm exceptions an uncaught one leaves main as a JS exception instead of reaching std::terminate;
// wasi.worker.ts hands its payload here to print what terminate would have.
extern "C" __attribute__((export_name("__ip_uncaught"))) void __ip_uncaught(void* unwind_exception) {
    __cxa_begin_catch(unwind_exception);
    const std::type_info* type = __cxa_current_exception_type();
    int status;
    char* name = __cxa_demangle(type->name(), nullptr, nullptr, &status);
    fflush(stdout);
    fprintf(stderr, "terminate called after throwing an instance of '%s'\n", name ? name : type->name());
    try {
        throw;
    } catch (const std::exception& e) {
        fprintf(stderr, "  what():  %s\n", e.what());
    } catch (...) {
    }
}
#endif
