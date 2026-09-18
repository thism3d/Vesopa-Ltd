-- Bangla for the plan copy that lives in the database.
--
-- Everyday spoken Bangla, with the words people say in English left in English
-- (SSL, NVMe, IP, WordPress, IMAP, SPF/DKIM/DMARC, GB). Every figure inside
-- these sentences is written in Bengali digits -- ৯৯.৯%, ১০ GB, ৩০ দিন -- which
-- is the half of "translate the numbers too" that no formatter can do for us:
-- these are prose, not values the page passes through num().
--
-- Re-runnable: it sets columns by slug and changes nothing else.

UPDATE plans SET
  name_bn = 'স্টার্টার',
  tagline_bn = 'একটি ওয়েবসাইট, ঠিকঠাক ভাবে।',
  features_bn = 'ফ্রি SSL সার্টিফিকেট, নিজে থেকেই রিনিউ হয়\nএক, দুই বা তিন বছরের যেকোনো প্ল্যানে ফ্রি ডোমেইন\nসাপ্তাহিক অফ-সাইট ব্যাকআপ\nএক ক্লিকে WordPress ইনস্টল\nUK ডেটা সেন্টার\n৯৯.৯% আপটাইমের নিশ্চয়তা\nইমেইল আর টিকেট সাপোর্ট'
WHERE slug = 'starter';

UPDATE plans SET
  name_bn = 'বিজনেস',
  tagline_bn = 'বাড়তে থাকা ব্যবসার যা যা দরকার।',
  badge_bn = 'সবচেয়ে জনপ্রিয়',
  features_bn = 'স্টার্টারের সব কিছু\nএক, দুই বা তিন বছরের যেকোনো প্ল্যানে ফ্রি ডোমেইন\nপ্রতিদিন ব্যাকআপ, নিজেই রিস্টোর করুন\nফ্রি ওয়েবসাইট মাইগ্রেশন\nস্টেজিং সাইট\nসীমাহীন ব্যান্ডউইথ\nWordPress টুলকিট'
WHERE slug = 'business';

UPDATE plans SET
  name_bn = 'প্রো',
  tagline_bn = 'যেসব সাইট নিজের খরচ তুলে আনে।',
  features_bn = 'বিজনেসের সব কিছু\nডেডিকেটেড রিসোর্সসহ NVMe স্টোরেজ\nপ্রায়োরিটি সাপোর্ট, আগে উত্তর\nপ্রতিদিনের ব্যাকআপ ৩০ দিন রাখা হয়\nফ্রি ডেডিকেটেড IP\nঅ্যাডভান্সড ক্যাশিং\nআপটাইম মনিটরিং'
WHERE slug = 'pro';

UPDATE email_plans SET
  name_bn = 'ইমেইল লাইট',
  tagline_bn = 'নিজের ডোমেইনে একটা ঠিকঠাক ঠিকানা।',
  features_bn = 'you@yourbusiness.co.uk\nপ্রতি মেইলবক্সে ১০ GB\nওয়েবমেইল, সঙ্গে ফোনে IMAP\nস্প্যাম আর ভাইরাস ফিল্টারিং\nক্যালেন্ডার আর কন্টাক্ট\nপুরোনো প্রোভাইডার থেকে ফ্রি মাইগ্রেশন'
WHERE slug = 'email-lite';

UPDATE email_plans SET
  name_bn = 'ইমেইল প্রো',
  tagline_bn = 'যে টিম ইনবক্সেই থাকে, তাদের জন্য।',
  features_bn = 'ইমেইল লাইটের সব কিছু\nপ্রতি মেইলবক্সে ৫০ GB\nশেয়ার্ড আর গ্রুপ মেইলবক্স\nযত খুশি ইমেইল অ্যালিয়াস\nরিটেনশন আর আর্কাইভ পলিসি\nপ্রায়োরিটি সাপোর্ট'
WHERE slug = 'email-pro';

UPDATE email_plans SET
  name_bn = 'মার্কেটিং এসেনশিয়ালস',
  tagline_bn = 'নিউজলেটার, যেটা ইনবক্সেই পৌঁছায়।',
  features_bn = 'মাসে ১০,০০০ পর্যন্ত সেন্ড\nড্র্যাগ-অ্যান্ড-ড্রপ ক্যাম্পেইন বিল্ডার\nSPF, DKIM আর DMARC দিয়ে সাইন করা\nওপেন আর ক্লিক রিপোর্ট\nআপনার সাইটের জন্য সাইনআপ ফর্ম\nআনসাবস্ক্রাইব সামলানো আমাদের দায়িত্ব'
WHERE slug = 'marketing-essentials';

UPDATE email_plans SET
  name_bn = 'মার্কেটিং প্রো',
  tagline_bn = 'অটোমেশন, সেগমেন্ট আর সত্যিকারের রিপোর্ট।',
  features_bn = 'এসেনশিয়ালসের সব কিছু\nমাসে ৫০,০০০ পর্যন্ত সেন্ড\nঅটোমেটেড সিকোয়েন্স আর ট্রিগার\nলিস্ট সেগমেন্টেশন\nA/B সাবজেক্ট লাইন টেস্টিং\nডেডিকেটেড সেন্ডিং IP নেওয়া যায়'
WHERE slug = 'marketing-pro';
