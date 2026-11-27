package bitter.jnibridge;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Drop-in replacement for Unity 2017.4 bitter.jnibridge.JNIBridge with Android 16 (API 36)
 * compatibility: handles Java 8 default methods newly added to framework interfaces such as
 * android.content.ServiceConnection.onServiceConnected(ComponentName, IBinder, IBinderSession)
 * without crashing the process with NoSuchMethodError.
 */
public class JNIBridge {
    static native Object invoke(long ptr, Class<?> cls, Method method, Object[] args);
    static native void delete(long ptr);

    static Object newInterfaceProxy(long ptr, Class<?>[] interfaces) {
        return Proxy.newProxyInstance(JNIBridge.class.getClassLoader(), interfaces, new a(ptr));
    }

    static void disableInterfaceProxy(Object proxy) {
        if (proxy != null) {
            ((a) Proxy.getInvocationHandler(proxy)).a();
        }
    }

    private static final class a implements InvocationHandler {
        private final Object a = new Object[0];
        private long b;

        public a(long ptr) {
            this.b = ptr;
        }

        public final Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            synchronized (this.a) {
                if (this.b == 0L) {
                    return null;
                }
                try {
                    return JNIBridge.invoke(this.b, method.getDeclaringClass(), method, args);
                } catch (NoSuchMethodError e) {
                    // Non-abstract interface method == Java 8 default method (e.g. Android 16 API 36)
                    if ((method.getModifiers() & 0x0400) == 0) {
                        try {
                            if ("onServiceConnected".equals(method.getName()) && args != null && args.length >= 2) {
                                Class<?>[] ptypes = method.getParameterTypes();
                                Method m2 = method.getDeclaringClass().getMethod(
                                    "onServiceConnected", ptypes[0], ptypes[1]);
                                return JNIBridge.invoke(this.b, m2.getDeclaringClass(), m2, new Object[]{ args[0], args[1] });
                            }
                        } catch (Throwable ignored) {
                        }
                        Class<?> ret = method.getReturnType();
                        if (ret == boolean.class) return Boolean.FALSE;
                        if (ret == byte.class) return Byte.valueOf((byte) 0);
                        if (ret == short.class) return Short.valueOf((short) 0);
                        if (ret == int.class) return Integer.valueOf(0);
                        if (ret == long.class) return Long.valueOf(0L);
                        if (ret == float.class) return Float.valueOf(0f);
                        if (ret == double.class) return Double.valueOf(0d);
                        if (ret == char.class) return Character.valueOf('\0');
                        return null;
                    }
                    throw e;
                }
            }
        }

        public final void finalize() {
            synchronized (this.a) {
                if (this.b != 0L) {
                    JNIBridge.delete(this.b);
                }
            }
        }

        public final void a() {
            synchronized (this.a) {
                this.b = 0L;
            }
        }
    }
}
