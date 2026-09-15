# Classes and methods called from libmaprama_engine.so through JNI (by name) must survive minification.
-keep class dev.maprama.enginenative.** { *; }
