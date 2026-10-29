# تشغيل مشروع F1 Fantasy — دليل المبتدئين

هذا الدليل يشرح تشغيل المشروع محليًا، ربطه بمشروع Supabase الصحيح، وتشغيل تحديثات Sprint.

> **مهم:** مشروع Supabase الصحيح هو `f1 fantasy` ومعرّفه `nufvwmjwqhzaztjxhdjg`، وليس المشروع القديم `xrvpwmarwncaaquywyce`.

## 1. المتطلبات

ثبّت على جهازك:

- Node.js إصدار 22 أو أحدث
- Git
- حساب GitHub لديه صلاحية على المستودع
- حساب Supabase لديه صلاحية على مشروع `f1 fantasy`

للتأكد من التثبيت افتح Terminal واكتب:

```bash
node -v
git --version
```

## 2. فتح المشروع من Terminal

### إذا لم يكن المشروع موجودًا على جهازك

```bash
cd ~
git clone https://github.com/mohamdy74/downforce-f1-fantasy.git
cd downforce-f1-fantasy
```

> **تنبيه مهم حاليًا:** ملفات Migration الجديدة موجودة في نسخة العمل الحالية، لكن محاولة رفعها إلى GitHub توقفت لأن جلسة GitHub في Terminal لم تكن مسجّلة الدخول. إذا لم تجد الملفين داخل مجلد `drizzle/migrations` بعد `clone`، نزّلهما من روابط الملفات الموجودة في نهاية هذا الدليل أو انسخ محتواهما إلى نفس المسار قبل تنفيذ خطوات Supabase.

### إذا كان موجودًا بالفعل

```bash
cd ~/downforce-f1-fantasy
git pull origin main
```

إذا ظهر خطأ أن المسار غير موجود، استخدم المسار الذي حفظت فيه المشروع بدل `~/downforce-f1-fantasy`.

## 3. تثبيت الحزم

داخل مجلد المشروع نفّذ:

```bash
npm install
```

ثم تأكد أن المشروع يبني:

```bash
npm run build
```

إذا ظهر `built successfully` أو `✓ built` فالبناء سليم.

## 4. إعداد Supabase الصحيح

افتح:

1. https://supabase.com/dashboard
2. منظمة `f1-fantasy`
3. مشروع `f1 fantasy`
4. افتح **SQL Editor**
5. اضغط **New query**

نفّذ السكريبتين بالترتيب التالي:

### السكريبت الأول

افتح الملف التالي من المشروع وانسخ محتواه كاملًا إلى SQL Editor:

`drizzle/migrations/0008_sprint_predictions_and_locks.sql`

اضغط **Run** وانتظر ظهور:

```text
Success. No rows returned
```

### السكريبت الثاني

افتح الملف التالي وانسخ محتواه كاملًا إلى Query جديدة:

`drizzle/migrations/0009_f1_fantasy_schema_alignment.sql`

اضغط **Run** وانتظر نجاح التنفيذ.

> السكريبتان يحتويان على أوامر آمنة نسبيًا لإعادة التشغيل مثل `IF NOT EXISTS`. لا تغيّر ترتيب التنفيذ.

## 5. التحقق من أن Singapore Sprint موجود

في SQL Editor نفّذ:

```sql
select
  season,
  round,
  name,
  has_sprint,
  sprint_qualifying_at,
  sprint_at
from public.races
where season = 2026 and round = 17;
```

يجب أن ترى تقريبًا:

| الحقل | القيمة |
|---|---|
| `season` | `2026` |
| `round` | `17` |
| `name` | `Singapore Grand Prix` |
| `has_sprint` | `true` |
| `sprint_qualifying_at` | `2026-10-09 12:30:00+00` |
| `sprint_at` | `2026-10-10 09:00:00+00` |

## 6. إعداد ملف البيئة المحلي

داخل مجلد المشروع أنشئ نسخة احتياطية أولًا:

```bash
cp .env .env.backup
```

افتح الملف:

```bash
nano .env
```

ابحث عن هذه القيم وعدّلها:

```env
SUPABASE_PROJECT_ID=nufvwmjwqhzaztjxhdjg
VITE_SUPABASE_PROJECT_ID=nufvwmjwqhzaztjxhdjg
SUPABASE_URL=https://nufvwmjwqhzaztjxhdjg.supabase.co
VITE_SUPABASE_URL=https://nufvwmjwqhzaztjxhdjg.supabase.co
SUPABASE_PUBLISHABLE_KEY=ضع_المفتاح_العام_هنا
VITE_SUPABASE_PUBLISHABLE_KEY=ضع_المفتاح_العام_هنا
```

احصل على المفتاح العام من:

**Supabase → Project Settings → API → Publishable key**

وفي المشاريع القديمة قد يكون اسمه **anon key**.

> استخدم المفتاح العام فقط. لا تضع `service_role` أو `sb_secret_` في كود الواجهة أو في ملف يمكن رفعه إلى GitHub.

في محرر `nano`:

- للحفظ: اضغط `Ctrl + O` ثم `Enter`
- للخروج: اضغط `Ctrl + X`

## 7. تشغيل الموقع محليًا

```bash
npm run dev
```

سيظهر لك رابط مثل:

```text
http://localhost:5173
```

افتحه في المتصفح.

لإيقاف الموقع من Terminal اضغط:

```text
Ctrl + C
```

## 8. اختبار سريع بعد التشغيل

اختبر بالترتيب:

1. افتح الصفحة الرئيسية.
2. سجّل الدخول.
3. تأكد أن قائمة **Sprint** تظهر.
4. افتح صفحة Sprint.
5. تأكد أن Singapore Grand Prix يظهر كسباق Sprint.
6. جرّب حفظ توقعات Top 8 وPole.
7. تأكد أن التوقعات لا تُحفظ بعد مواعيد القفل.

## 9. رفع التغييرات إلى GitHub

بعد التأكد من أن الموقع يعمل:

```bash
cd ~/downforce-f1-fantasy
git status
git add drizzle/migrations/0008_sprint_predictions_and_locks.sql
git add drizzle/migrations/0009_f1_fantasy_schema_alignment.sql
git commit -m "Add sprint prediction locks and align race schema"
git push origin main
```

إذا كان المستودع الذي نزّلته لا يحتوي الملفين الجديدين، ضعهما أولًا داخل `drizzle/migrations/`:

- `0008_sprint_predictions_and_locks.sql`
- `0009_f1_fantasy_schema_alignment.sql`

ثم نفّذ أوامر `git add` و`git commit` و`git push` السابقة.

إذا طلب GitHub اسم المستخدم وكلمة المرور، لا تستخدم كلمة مرور الحساب. استخدم تسجيل الدخول من GitHub CLI أو Personal Access Token.

### الطريقة الأسهل باستخدام GitHub CLI

إذا كان `gh` مثبتًا:

```bash
gh auth login
git push origin main
```

اختر:

- GitHub.com
- HTTPS
- Login with web browser

إذا لم يكن `gh` مثبتًا، يمكنك تثبيته من https://cli.github.com ثم إعادة الأوامر.

## 10. ربط Lovable

في Lovable:

1. افتح المشروع.
2. افتح **Settings / Cloud / Environment variables** حسب الواجهة الظاهرة.
3. غيّر مشروع Supabase إلى:
   - Project ID: `nufvwmjwqhzaztjxhdjg`
   - URL: `https://nufvwmjwqhzaztjxhdjg.supabase.co`
4. حدّث المفتاح العام Publishable/anon.
5. اعمل Sync أو Pull من GitHub.
6. أعد تشغيل Preview.

إذا كان Lovable مربوطًا تلقائيًا بـ Supabase قد تحتاج إلى فصل المشروع القديم ثم اختيار مشروع `f1 fantasy` الصحيح.

## 11. أوامر الفحص النهائية

```bash
cd ~/downforce-f1-fantasy
npm install
npm run build
git status
git log -1 --oneline
```

النتيجة المطلوبة:

- `npm run build` ينجح.
- `git status` لا يعرض ملفات غير محفوظة، أو يعرض فقط تغييراتك المقصودة.
- آخر commit يحتوي على migration الخاصة بـ Sprint.

## مشاكل شائعة

### `Missing Supabase environment variable`

تأكد من وجود:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

ثم أوقف `npm run dev` وشغّله مرة أخرى.

### الموقع يفتح لكن لا يعرض البيانات

غالبًا ملف البيئة ما زال يشير إلى المشروع القديم. تأكد أن الرابط يحتوي على:

```text
nufvwmjwqhzaztjxhdjg.supabase.co
```

### `git push` يرفض الدخول

نفّذ:

```bash
gh auth login
git push origin main
```

ولا ترسل أي Token أو مفتاح في المحادثة.

### `npm run lint` يعرض أخطاء Prettier

هذا المشروع لديه أخطاء تنسيق قديمة في ملفات الواجهة. لا تشغّل `npm run format` على المشروع كله قبل أخذ نسخة احتياطية؛ لأنه قد يغيّر ملفات كثيرة. معيار التحقق الأساسي حاليًا هو:

```bash
npm run build
```
