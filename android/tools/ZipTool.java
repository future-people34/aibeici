import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * 把 classes.dex 等文件合并进 aapt2 产出的 APK。
 * 用法：java ZipTool <基础 apk> <要追加的目录> <输出的 apk>
 *
 * 自己写而不用 zip 命令，是为了原样保留 resources.arsc 的「不压缩」属性
 * —— targetSdk 30+ 要求 resources.arsc 未压缩且 4 字节对齐。
 */
public class ZipTool {

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("用法: java ZipTool <base.apk> <addDir> <out.apk>");
            System.exit(2);
        }
        File base = new File(args[0]);
        File addDir = new File(args[1]);
        File out = new File(args[2]);
        if (out.exists()) out.delete();

        Set<String> written = new HashSet<>();
        int copied = 0;
        int added = 0;

        try (ZipFile zin = new ZipFile(base);
             ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(out))) {

            Enumeration<? extends ZipEntry> en = zin.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                // 顺带把可能混进来的反斜杠条目名规范化（Windows 上 aapt2 曾经这么干过）
                String name = e.getName().replace('\\', '/');
                ZipEntry ne = new ZipEntry(name);
                ne.setMethod(e.getMethod());
                if (e.getMethod() == ZipEntry.STORED) {
                    ne.setSize(e.getSize());
                    ne.setCompressedSize(e.getSize());
                    ne.setCrc(e.getCrc());
                }
                zos.putNextEntry(ne);
                try (InputStream in = zin.getInputStream(e)) {
                    copy(in, zos);
                }
                zos.closeEntry();
                written.add(name);
                copied++;
            }

            List<File> files = new ArrayList<>();
            collect(addDir, files);
            files.sort(Comparator.comparing(File::getAbsolutePath));
            for (File f : files) {
                String rel = addDir.toPath().relativize(f.toPath()).toString().replace('\\', '/');
                if (written.contains(rel)) continue;
                ZipEntry ne = new ZipEntry(rel);
                ne.setMethod(ZipEntry.DEFLATED);
                zos.putNextEntry(ne);
                try (InputStream in = new FileInputStream(f)) {
                    copy(in, zos);
                }
                zos.closeEntry();
                added++;
                System.out.println("  + " + rel + "  (" + f.length() + " bytes)");
            }
        }
        System.out.println("ZipTool: 复制 " + copied + " 项，追加 " + added + " 项 → " + out.getName());
    }

    private static void collect(File dir, List<File> out) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File c : children) {
            if (c.isDirectory()) collect(c, out);
            else out.add(c);
        }
    }

    private static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        copy(in, bos);
        return bos.toByteArray();
    }
}
