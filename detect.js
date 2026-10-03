/* =====================================================================
   FAMILY VAULT — document reader
   Looks at the text read from a document and works out:
     • what kind of document it is (Aadhaar, PAN, birth certificate …)
     • whose document it is (matched against your family members)
     • its ID number (used to catch duplicates)
     • its expiry date, if it has one
     • a suggested name, e.g. "Diansh Birth Certificate"
   No internet, no AI service — everything happens on the phone.
   ===================================================================== */
(function (root) {
  'use strict';

  // ---------- small helpers ----------
  const has = (T, re) => re.test(T);
  const titleCase = s => String(s || '').toLowerCase()
    .replace(/(^|[\s.\-'])([a-z])/g, (m, a, b) => a + b.toUpperCase()).trim();
  const letters = s => (String(s || '').match(/[A-Za-z]/g) || []).length;

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  // same word, allowing one wrong letter on longer words (scans often misread a letter)
  const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);

  const BANKS = [
    [/STATE BANK OF INDIA|\bSBI\b/, 'SBI'], [/FEDERAL BANK|FEDRAL BANK/, 'Federal Bank'],
    [/BANK OF BARODA/, 'Bank of Baroda'], [/\bHDFC\b/, 'HDFC Bank'], [/\bICICI\b/, 'ICICI Bank'],
    [/AXIS BANK/, 'Axis Bank'], [/PUNJAB NATIONAL|\bPNB\b/, 'PNB'], [/\bUCO BANK/, 'UCO Bank'],
    [/CANARA BANK/, 'Canara Bank'], [/UNION BANK/, 'Union Bank'], [/INDIAN OVERSEAS/, 'IOB'],
    [/CENTRAL BANK/, 'Central Bank'], [/BANDHAN/, 'Bandhan Bank'], [/KOTAK/, 'Kotak Bank'],
    [/\bIDBI\b/, 'IDBI Bank'], [/ASSAM GRAMIN/, 'Assam Gramin Bank'], [/YES BANK/, 'Yes Bank'],
    [/INDIAN BANK/, 'Indian Bank'], [/BANK OF INDIA/, 'Bank of India'], [/INDIA POST|POST OFFICE/, 'Post Office']
  ];
  const bankOf = T => { for (const [re, n] of BANKS) if (re.test(T)) return n; return ''; };

  const STATES = 'AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB'.split(' ');
  function vehicleNo(T) {
    const re = /\b([A-Z]{2})[\s\-]?(\d{1,2})[\s\-]?([A-Z]{1,3})[\s\-]?(\d{4})\b/g;
    let m;
    while ((m = re.exec(T))) {
      if (STATES.includes(m[1])) return m[1] + m[2].padStart(2, '0') + m[3] + m[4];
    }
    const bh = T.match(/\b(\d{2})\s?BH\s?(\d{4})\s?([A-Z]{1,2})\b/);
    return bh ? bh[1] + 'BH' + bh[2] + bh[3] : '';
  }

  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
  function classOf(T) {
    if (/HIGHER SECONDARY|SENIOR SECONDARY|SENIOR SCHOOL CERTIFICATE|\bAHSEC\b|\bHS FINAL|\bHSC\b|CLASS\s*[-:]?\s*(XII|12)\b/.test(T)) return 'Class 12';
    if (/\bHSLC\b|HIGH SCHOOL LEAVING|MATRICULATION|SECONDARY SCHOOL (LEAVING )?(CERTIFICATE )?EXAM|\bSSLC\b|\bSSC\b|\bSEBA\b|CLASS\s*[-:]?\s*(X|10)\b/.test(T)) return 'Class 10';
    const m = T.match(/\b(?:CLASS|STD|STANDARD|GRADE)\s*[-:.]?\s*(XI|IX|X|VIII|VII|VI|IV|V|III|II|I|\d{1,2})\b/);
    if (m) return 'Class ' + (ROMAN[m[1]] || +m[1]);
    if (/B\.?\s?COM\b|BACHELOR OF COMMERCE/.test(T)) return 'B.Com';
    if (/B\.?\s?SC\b|BACHELOR OF SCIENCE/.test(T)) return 'B.Sc';
    if (/BACHELOR OF ARTS|\bB\.\s?A\.?\b/.test(T)) return 'B.A.';
    if (/B\.?\s?TECH|BACHELOR OF TECHNOLOGY|B\.?\s?E\.?\b|BACHELOR OF ENGINEERING/.test(T)) return 'B.Tech';
    if (/M\.?\s?COM\b|MASTER OF COMMERCE/.test(T)) return 'M.Com';
    if (/\bMBA\b|BUSINESS ADMINISTRATION/.test(T)) return 'MBA';
    if (/SEMESTER\s*[-:]?\s*(\d|[IVX]+)\b/.test(T)) { const s = T.match(/SEMESTER\s*[-:]?\s*(\d|[IVX]+)\b/)[1]; return 'Semester ' + (ROMAN[s] || s); }
    return '';
  }

  function assessmentYear(T) {
    const m = T.match(/ASSESSMENT\s*YEAR\s*[:\-]?\s*(20\d{2})\s*[-–\/]\s*(\d{2,4})/);
    if (m) return 'AY ' + m[1] + '-' + m[2].slice(-2);
    const f = T.match(/FINANCIAL\s*YEAR\s*[:\-]?\s*(20\d{2})\s*[-–\/]\s*(\d{2,4})/);
    return f ? 'FY ' + f[1] + '-' + f[2].slice(-2) : '';
  }

  // ---------- document types ----------
  // Every kind of document is scored, and the best score wins.
  //   strong = a phrase that names the document (e.g. "BIRTH CERTIFICATE") — 15 points in the
  //            heading (first lines), 8 further down, plus 4 for each further strong phrase
  //   weak   = words such documents usually contain — 3 points each, at most 9
  //   need   = must be present, otherwise this kind is ruled out
  //   base   = points for a strong phrase when lower than 10 (vague words like "Receipt")
  //   maxLen = ruled out when the document has more letters than this (ID cards are short)
  // A kind needs 8 points to be suggested; otherwise the file name is used instead.
  const R = s => new RegExp(s);
  const TYPES = [
    { key: 'itr', label: 'ITR', strong: [/INDIAN INCOME TAX RETURN/, /\bITR\s?-?\s?V\b/, /ITR ACKNOWLEDGEMENT/, /INCOME TAX RETURN/], weak: [/ASSESSMENT YEAR/, /ACKNOWLEDGEMENT NUMBER/, /E-?FILING/, /\bCPC\b/, /TOTAL INCOME/], extra: assessmentYear, extraAfter: true },
    { key: 'form16', label: 'Form 16', strong: [/\bFORM\s*(NO\.?\s*)?16\b/], need: /TAX DEDUCTED|\bTDS\b|DEDUCTOR/, weak: [/\bTAN\b/, /DEDUCTOR/, /EMPLOYER/], extra: assessmentYear, extraAfter: true },
    { key: 'gst', label: 'GST Certificate', strong: [/\bREG\s?-?\s?06\b/, /FORM GST REG/, /REGISTRATION CERTIFICATE.{0,60}GOODS AND SERVICES/], weak: [/GOODS AND SERVICES TAX/, /\bGSTIN\b/, /CONSTITUTION OF BUSINESS/, /PRINCIPAL PLACE/] },
    { key: 'udyam', label: 'Udyam Certificate', strong: [/UDYAM REGISTRATION/, /UDYAM-[A-Z]{2}-/], weak: [/MSME/, /ENTERPRISE/] },
    { key: 'fssai', label: 'FSSAI Licence', strong: [/FOOD SAFETY AND STANDARDS AUTHORITY/, /FSSAI.{0,40}(LICEN|REGISTRATION CERTIFICATE)/], weak: [/FOOD BUSINESS/], expires: true },
    { key: 'trade', label: 'Trade Licence', strong: [/TRADE LICEN/], weak: [/MUNICIPAL/, /VALID/], expires: true },
    { key: 'passport', label: 'Passport', strong: [/P<IND/, /REPUBLIC OF INDIA.{0,60}PASSPORT|PASSPORT.{0,60}REPUBLIC OF INDIA/], weak: [/PASSPORT NO/, /NATIONALITY/, /PLACE OF ISSUE/, /FILE NO/, /DATE OF EXPIRY/], expires: true },
    { key: 'death', label: 'Death Certificate', strong: [/DEATH CERTIFICATE/, /CERTIFICATE OF DEATH/], weak: [/DATE OF DEATH/, /DECEASED/, /PLACE OF DEATH/, /CAUSE OF DEATH/] },
    { key: 'birth', label: 'Birth Certificate', strong: [/BIRTH CERTIFICATE/, /CERTIFICATE OF BIRTH/, /REGISTRATION OF BIRTH/, /BIRTH REGISTRATION/, /EXTRACT OF BIRTH/], weak: [/PLACE OF BIRTH/, /NAME OF (THE )?MOTHER/, /NAME OF (THE )?FATHER/, /BIRTHS AND DEATHS/] },
    { key: 'marriage', label: 'Marriage Certificate', strong: [/MARRIAGE CERTIFICATE/, /CERTIFICATE OF MARRIAGE/, /REGISTRATION OF MARRIAGE/, /MARRIAGE REGISTRATION/], weak: [/BRIDE/, /BRIDEGROOM/, /SOLEMNI[SZ]ED/, /MARRIAGE ACT/] },
    { key: 'admit', label: 'Admit Card', strong: [/ADMIT CARD/, /HALL TICKET/], weak: [/ROLL NO/, /EXAMINATION CENT/, /INVIGILATOR/], extra: classOf },
    { key: 'marksheet', label: 'Marksheet', strong: [/MARKS?\s?-?SHEET/, /STATEMENT OF MARKS/, /MARKS STATEMENT/, /GRADE\s?SHEET/, /GRADE CARD/, /REPORT CARD/, /PROGRESS REPORT/], weak: [/MARKS OBTAINED/, /MAX(IMUM)?\.? MARKS/, /TOTAL MARKS/, /ROLL NO/, /SUBJECTS?/, /RESULT/], extra: classOf },
    { key: 'tc', label: 'Transfer Certificate', strong: [/TRANSFER CERTIFICATE/, /(?<!HIGH )SCHOOL LEAVING CERTIFICATE(?! EXAM)/], weak: [/ADMISSION NO/, /DATE OF LEAVING/, /CONDUCT/] },
    { key: 'migration', label: 'Migration Certificate', strong: [/MIGRATION CERTIFICATE/], weak: [/UNIVERSITY|BOARD|COUNCIL/] },
    { key: 'passcert', label: 'Pass Certificate', strong: [/PASS CERTIFICATE/, /PASSING CERTIFICATE/], weak: [/HAS PASSED|PASSED THE/, /EXAMINATION/, /BOARD|COUNCIL/, /DIVISION/], extra: classOf },
    { key: 'degree', label: 'Degree Certificate', strong: [/DEGREE CERTIFICATE/, /CONVOCATION/, /CONFERRED/], weak: [/UNIVERSITY/, /BACHELOR OF|MASTER OF/, /DEGREE/], extra: classOf },
    { key: 'puc', label: 'PUC', strong: [/POLLUTION UNDER CONTROL/, /\bPUCC\b/, /PUC CERTIFICATE/], weak: [/EMISSION/, /\bHC\b|\bCO\b/, /TEST/], expires: true, vehicle: true },
    { key: 'premium', label: 'Premium Receipt', strong: [/PREMIUM RECEIPT/, /RENEWAL PREMIUM/, /PREMIUM PAID (CERTIFICATE|STATEMENT)/, /RECEIPT.{0,30}PREMIUM/, /PREMIUM (PAYMENT )?ACKNOWLEDGEMENT/], weak: [/POLICY (NO|NUMBER)/, /AMOUNT/, /DUE DATE|NEXT DUE/, /INSURANCE|ASSURANCE/], sub: T => ({ label: 'Premium Receipt', insurer: insuranceKind(T).insurer }), recurring: 'month' },
    { key: 'insurance', label: 'Insurance', strong: [/CERTIFICATE OF INSURANCE/, /POLICY SCHEDULE|SCHEDULE OF (THE )?POLICY/, /INSURANCE POLICY/, /POLICY DOCUMENT/, /POLICY (CERTIFICATE|BOND)/], weak: [/INSURANCE|ASSURANCE/, /PREMIUM/, /SUM (INSURED|ASSURED)/, /POLICY (NO|NUMBER)/, /INSURED/, /NOMINEE/, /\bIRDAI?\b/], expires: true, sub: insuranceKind },
    { key: 'rc', label: 'RC', strong: [/CERTIFICATE OF REGISTRATION/, /REGISTRATION CERTIFICATE/, /\bR\.?C\.?\s?BOOK/, /\bFORM\s?(NO\.?\s?)?23\b/], need: /CHASSIS|ENGINE|MAKER|FUEL|VEHICLE CLASS|BODY TYPE|SEATING/, weak: [/CHASSIS/, /ENGINE (NO|NUMBER)/, /MAKER/, /FUEL/, /SEATING/, /UNLADEN/, /VEHICLE CLASS|CLASS OF VEHICLE/], expires: true, vehicle: true },
    { key: 'dl', label: 'Driving Licence', strong: [/DRIVING\s?LICEN/, /LICEN[CS]E TO DRIVE/], weak: [/\bDL\s?NO/, /\bCOV\b/, /CLASS OF VEHICLE/, /\bNT\b|\bTR\b/, /VALID TILL/, /BLOOD GROUP/], expires: true },
    { key: 'voter', label: 'Voter ID', strong: [/ELECTION COMMISSION OF INDIA/, /ELECTOR'?S? PHOTO IDENTITY/, /\bEPIC\b/], weak: [/ELECTOR/, /ASSEMBLY CONSTITUENCY/, /PART NO/] },
    { key: 'pan', label: 'PAN Card', strong: [/PERMANENT ACCOUNT NUMBER CARD/, /INCOME\s?TAX DEPARTMENT/], need: /\b[A-Z]{5}\d{4}[A-Z]\b|PERMANENT ACCOUNT NUMBER CARD/, weak: [/PERMANENT ACCOUNT NUMBER/, /GOVT\.? OF INDIA|GOVERNMENT OF INDIA/, /SIGNATURE/], maxLen: 900 },
    { key: 'aadhaar', label: 'Aadhaar Card', strong: [/UNIQUE IDENTIFICATION AUTHORITY/, /MERA AADHAAR/, /AAM AADMI KA ADHIKAR/, /ENROL?MENT NO/], need: /[2-9]\d{3}\s?\d{4}\s?\d{4}|UNIQUE IDENTIFICATION AUTHORITY/, weak: [/AADHAA?R|AADHAR/, /\bVID\b/, /GOVERNMENT OF INDIA/, /\bUIDAI\b/, /\bDOB\b|YEAR OF BIRTH/], maxLen: 4000 },
    { key: 'ration', label: 'Ration Card', strong: [/RATION CARD/, /NATIONAL FOOD SECURITY/, /PUBLIC DISTRIBUTION SYSTEM/], weak: [/\bNFSA\b/, /FAIR PRICE SHOP/, /HEAD OF (THE )?FAMILY/] },
    { key: 'prc', label: 'PRC', strong: [/PERMANENT RESIDEN(T|CE|TIAL) CERTIFICATE/] },
    { key: 'income', label: 'Income Certificate', strong: [/INCOME CERTIFICATE/], weak: [/ANNUAL INCOME/] },
    { key: 'ncl', label: 'Non-Creamy Layer Certificate', strong: [/NON.?CREAMY/] },
    { key: 'caste', label: 'Caste Certificate', strong: [/CASTE CERTIFICATE/, /COMMUNITY CERTIFICATE/] },
    { key: 'domicile', label: 'Domicile Certificate', strong: [/DOMICILE CERTIFICATE/, /CERTIFICATE OF DOMICILE/] },
    { key: 'residence', label: 'Residence Certificate', strong: [/RESIDEN(CE|TIAL) CERTIFICATE/] },
    { key: 'vaccine', label: 'Vaccination Certificate', strong: [/VACCINATION CERTIFICATE/, /CERTIFICATE FOR COVID/, /\bCO-?WIN\b/, /IMMUNI[SZ]ATION (CARD|RECORD)/], weak: [/VACCINE/, /DOSE/] },
    { key: 'discharge', label: 'Discharge Summary', strong: [/DISCHARGE SUMMARY/, /DISCHARGE CERTIFICATE/], weak: [/DATE OF ADMISSION/, /DIAGNOSIS/, /TREATING DOCTOR/] },
    { key: 'medical', label: 'Medical Report', strong: [/LAB(ORATORY)? REPORT/, /TEST REPORT/, /PATHOLOGY/, /PRESCRIPTION/, /RADIOLOGY|ULTRASOUND|X-RAY|\bMRI\b|CT SCAN/], weak: [/HA?EMOGLOBIN/, /REFERENCE (RANGE|INTERVAL)/, /DIAGNOSIS/, /\bMBBS\b|\bM\.D\.?\b/, /SPECIMEN|SAMPLE/, /\bRX\b/, /PATIENT/] },
    { key: 'salary', label: 'Salary Slip', strong: [/SALARY SLIP/, /PAY\s?SLIP/, /SALARY STATEMENT/], weak: [/BASIC/, /\bHRA\b/, /GROSS/, /NET PAY|NET SALARY/], recurring: 'month' },
    { key: 'fd', label: 'FD Receipt', strong: [/FIXED DEPOSIT/, /TERM DEPOSIT/, /DEPOSIT RECEIPT/, /\bFDR\b/], weak: [/MATURITY/, /RATE OF INTEREST/, /DEPOSIT/], bank: true },
    { key: 'cheque', label: 'Cancelled Cheque', strong: [/OR BEARER/, /OR ORDER/], weak: [/\bIFSC\b/, /A\/C/, /RUPEES/, /\bPAY\b/], bank: true },
    { key: 'passbook', label: 'Passbook', strong: [/PASS\s?BOOK/], weak: [/\bCIF\b/, /\bIFSC\b/, /BALANCE/], bank: true },
    { key: 'statement', label: 'Bank Statement', strong: [/STATEMENT OF ACCOUNT\b/, /ACCOUNT STATEMENT\b/, /BANK STATEMENT\b/], weak: [/OPENING BALANCE/, /CLOSING BALANCE/, /WITHDRAWAL/, /NARRATION|PARTICULARS/, /\bIFSC\b/], bank: true, recurring: 'range' },
    { key: 'electricity', label: 'Electricity Bill', strong: [/ELECTRICITY BILL/, /ENERGY BILL/, /\bAPDCL\b/, /POWER DISTRIBUTION/], weak: [/UNITS/, /CONSUMER (NO|NUMBER|ID)/, /METER/, /\bKWH\b/, /TARIFF/], recurring: 'month' },
    { key: 'gas', label: 'Gas Connection', strong: [/GAS CONNECTION/, /\bINDANE\b/, /BHARAT ?GAS/, /\bHP ?GAS\b/, /SUBSCRIPTION VOUCHER/], weak: [/\bLPG\b/, /CYLINDER/, /CONSUMER NO/] },
    { key: 'phonebill', label: 'Phone Bill', strong: [/(JIO|AIRTEL|BSNL|VODAFONE|\bVI\b).{0,40}BILL/, /POSTPAID BILL/, /TELEPHONE BILL/], weak: [/MOBILE (NO|NUMBER)/, /PLAN/, /DATA/], recurring: 'month', operator: true },
    { key: 'recharge', label: 'Recharge', strong: [/RECHARGE/, /PREPAID PLAN/], need: /JIO|AIRTEL|BSNL|VODAFONE|\bVI\b|MOBILE|PREPAID|DTH|TATA PLAY|DISH ?TV/, weak: [/VALIDITY/, /\bPLAN\b/, /\bDATA\b/, /TRANSACTION (ID|NO)|ORDER ID/, /MOBILE (NO|NUMBER)/, /SUCCESSFUL/], recurring: 'month', operator: true },
    { key: 'saledeed', label: 'Sale Deed', strong: [/SALE DEED/, /DEED OF SALE/, /CONVEYANCE DEED/], weak: [/VENDOR/, /PURCHASER|VENDEE/, /SCHEDULE OF (THE )?PROPERTY/] },
    { key: 'giftdeed', label: 'Gift Deed', strong: [/GIFT DEED/, /DEED OF GIFT/], weak: [/DONOR/, /DONEE/] },
    { key: 'jamabandi', label: 'Jamabandi', strong: [/JAMABANDI/], weak: [/\bDAG\b/, /PATTA/] },
    { key: 'mutation', label: 'Land Mutation', strong: [/MUTATION/], need: /LAND|\bDAG\b|PATTA/, weak: [/\bDAG\b/, /PATTA/, /CIRCLE OFFICER/] },
    { key: 'patta', label: 'Land Patta', strong: [/\bPATTA\b/, /\bDAG\s?NO/], weak: [/BIGHA|KATHA|LESSA/, /REVENUE/, /CIRCLE/] },
    { key: 'proptax', label: 'Property Tax Receipt', strong: [/HOLDING TAX/, /PROPERTY TAX/], weak: [/MUNICIPAL/, /HOLDING NO/] },
    { key: 'rent', label: 'Rent Agreement', strong: [/RENT AGREEMENT/, /LEASE AGREEMENT/, /LEASE DEED/, /LEAVE AND LICEN/, /TENANCY AGREEMENT/], weak: [/LESSOR|LANDLORD/, /LESSEE|TENANT/, /MONTHLY RENT/], expires: true },
    { key: 'will', label: 'Will', strong: [/LAST WILL/, /WILL AND TESTAMENT/], weak: [/EXECUTOR/, /BEQUEATH/] },
    { key: 'poa', label: 'Power of Attorney', strong: [/POWER OF ATTORNEY/] },
    { key: 'affidavit', label: 'Affidavit', strong: [/AFFIDAVIT/], weak: [/DEPONENT/, /SOLEMNLY/, /NOTARY/] },
    { key: 'warranty', label: 'Warranty Card', strong: [/WARRANTY CARD/, /WARRANTY CERTIFICATE/, /GUARANTEE CARD/], weak: [/WARRANTY/, /SERIAL NO/, /MODEL/], expires: true },
    { key: 'freight', label: 'Freight Bill', strong: [/FREIGHT BILL/, /FREIGHT INVOICE/, /FREIGHT MEMO/, /TRANSPORT(ATION)? BILL/, /BILL FOR FREIGHT/], weak: [/CONSIGNOR/, /CONSIGNEE/, /LORRY|TRUCK|VEHICLE NO/, /ROADWAYS|CARRIERS?|TRANSPORT|LOGISTICS|CARGO/, /\bL\.?\s?R\.?\s?NO|\bG\.?\s?R\.?\s?NO/], noPerson: true, extra: sellerAndDate, recurring: 'date' },
    { key: 'invoice', label: 'Invoice', strong: [/TAX INVOICE/, /BILL OF SUPPLY/, /INVOICE (NO|NUMBER)/, /CASH MEMO/, /RETAIL INVOICE/], weak: [/\bGSTIN\b/, /\bHSN\b/, /\bCGST\b|\bSGST\b|\bIGST\b/, /\bQTY\b|QUANTITY/, /\bRATE\b/, /GRAND TOTAL|TOTAL AMOUNT/], noPerson: true, extra: sellerAndDate, recurring: 'date' },
    { key: 'lr', label: 'LR', strong: [/LORRY RECEIPT/, /CONSIGNMENT NOTE/, /\bG\.?\s?C\.?\s?NOTE/, /GOODS RECEIPT NOTE/], weak: [/CONSIGNOR/, /CONSIGNEE/, /\bL\.?\s?R\.?\s?NO|\bG\.?\s?R\.?\s?NO|\bC\.?\s?N\.?\s?NO/, /PACKAGES|PKGS|\bBAGS\b/, /WEIGHT/, /FREIGHT/], noPerson: true, extra: sellerAndDate, recurring: 'date' },
    { key: 'resume', label: 'Resume', strong: [/CURRICULUM VITAE/, /\bRESUME\b/, /\bBIO-?DATA\b/], weak: [/EDUCATION/, /EXPERIENCE/, /HOBBIES/] },
    { key: 'appform', label: 'Application Form', strong: [/APPLICATION FORM/], base: 6, bank: true },
    { key: 'letter', label: 'Letter', strong: [/\bSUBJECT\s*:/, /YOURS (FAITHFULLY|SINCERELY|TRULY)/, /^(TO|DEAR)\b/], base: 10, weak: [/\bDEAR\b/, /\bREGARDS\b/, /\bREF(ERENCE)?\s*(NO)?\s*:/] },
    { key: 'agreement', label: 'Agreement', strong: [/\bAGREEMENT\b/], base: 6, weak: [/WITNESS/, /PARTY OF THE (FIRST|SECOND) PART/] },
    { key: 'receipt', label: 'Receipt', strong: [/\bRECEIPT\b/], base: 6, weak: [/RECEIVED (WITH THANKS|FROM)/, /AMOUNT/] },
    { key: 'certificate', label: 'Certificate', strong: [/\bCERTIFICATE\b/], base: 6, weak: [/THIS IS TO CERTIFY/, /ISSUED/] }
  ];

  function scoreType(t, T, H, nLetters) {
    if (t.need && !t.need.test(T)) return 0;
    if (t.maxLen && nLetters > t.maxLen) return 0;
    const base = t.base || 10;
    let s = 0, n = 0;
    for (const re of t.strong || []) {
      if (!re.test(T)) continue;
      // a document's own name is usually in its heading; deeper down it may just be mentioned
      // ("please send your bank statement"), so it counts for less there
      s += n === 0 ? (re.test(H) ? base + 5 : base - 2) : 4;
      n++;
    }
    if (!n) return 0;
    let w = 0;
    for (const re of t.weak || []) if (re.test(T)) w += 3;
    return s + Math.min(w, 9);
  }
  function pickType(T, H, nLetters) {
    let best = null, bestScore = 0;
    for (const t of TYPES) {
      const sc = scoreType(t, T, H, nLetters);
      if (sc > bestScore) { best = t; bestScore = sc; }
    }
    return bestScore >= 8 ? best : null;
  }

  // Which kind of insurance: count the tell-tale words of each kind; the most wins
  const INSURERS = [
    [/STAR HEALTH/, 'Star Health', 'health'], [/CARE HEALTH|RELIGARE/, 'Care Health', 'health'], [/NIVA BUPA|MAX BUPA/, 'Niva Bupa', 'health'],
    [/MANIPAL\s?CIGNA/, 'ManipalCigna', 'health'], [/ADITYA BIRLA HEALTH/, 'Aditya Birla Health', 'health'],
    [/LIFE INSURANCE CORPORATION|\bLIC OF INDIA\b/, 'LIC', 'life'], [/SBI LIFE/, 'SBI Life', 'life'], [/HDFC LIFE/, 'HDFC Life', 'life'],
    [/MAX LIFE|AXIS MAX LIFE/, 'Max Life', 'life'], [/ICICI PRUDENTIAL/, 'ICICI Prudential', 'life'], [/TATA AIA/, 'Tata AIA', 'life'],
    [/BAJAJ (ALLIANZ )?LIFE/, 'Bajaj Life', 'life'], [/PNB METLIFE/, 'PNB MetLife', 'life'], [/KOTAK LIFE/, 'Kotak Life', 'life'],
    [/NEW INDIA ASSURANCE/, 'New India Assurance'], [/NATIONAL INSURANCE/, 'National Insurance'], [/UNITED INDIA/, 'United India'],
    [/ORIENTAL INSURANCE/, 'Oriental Insurance'], [/ICICI LOMBARD/, 'ICICI Lombard'], [/HDFC ERGO/, 'HDFC Ergo'],
    [/BAJAJ (ALLIANZ )?GENERAL|BAJAJ ALLIANZ/, 'Bajaj Allianz'], [/TATA AIG/, 'Tata AIG'], [/SBI GENERAL/, 'SBI General'],
    [/RELIANCE GENERAL/, 'Reliance General'], [/\bGO DIGIT\b|DIGIT INSURANCE/, 'Digit'], [/\bACKO\b/, 'Acko'],
    [/IFFCO.?TOKIO/, 'IFFCO Tokio'], [/CHOLAMANDALAM|CHOLA MS/, 'Chola MS'], [/ROYAL SUNDARAM/, 'Royal Sundaram'],
    [/FUTURE GENERALI/, 'Future Generali'], [/UNIVERSAL SOMPO/, 'Universal Sompo'], [/KOTAK (MAHINDRA )?GENERAL/, 'Kotak General']
  ];
  const INS_KIND = {
    health: [/HEALTH/, /MEDICLAIM/, /HOSPITALI[SZ]ATION/, /FAMILY FLOATER/, /CASHLESS/, /\bTPA\b/, /PRE-?EXISTING/, /ROOM RENT/, /DAY CARE/, /CRITICAL ILLNESS/, /AYUSH/, /CO-?PAY/],
    motor: [/\bMOTOR\b/, /PRIVATE CAR/, /TWO WHEELER/, /GOODS CARRYING/, /COMMERCIAL VEHICLE/, /CHASSIS/, /ENGINE (NO|NUMBER)/, /CUBIC CAPACITY|\bCC\b/, /\bIDV\b|INSURED DECLARED VALUE/, /OWN DAMAGE/, /THIRD PARTY/, /NO CLAIM BONUS|\bNCB\b/, /MAKE.{0,10}MODEL/],
    life: [/LIFE (INSURANCE|ASSURANCE)/, /JEEVAN/, /SUM ASSURED/, /MATURITY/, /DEATH BENEFIT/, /TERM (PLAN|INSURANCE)/, /ENDOWMENT/, /\bULIP\b/, /SURRENDER/, /LIFE ASSURED/],
    property: [/\bFIRE\b/, /BURGLARY/, /SHOPKEEPER/, /STOCK/, /BUILDING/, /HOUSEHOLDER/, /STANDARD FIRE/, /SPECIAL PERILS/]
  };
  function insuranceKind(T) {
    const score = { health: 0, motor: 0, life: 0, property: 0 };
    for (const k in INS_KIND) for (const re of INS_KIND[k]) if (re.test(T)) score[k] += 2;
    let insurer = '';
    for (const [re, name, kind] of INSURERS) if (re.test(T)) { insurer = name; if (kind) score[kind] += 6; break; }
    if (score.motor && vehicleNo(T)) score.motor += 2;
    const [kind, sc] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    const label = sc < 4 ? 'Insurance Policy' : { health: 'Health Insurance', motor: 'Vehicle Insurance', life: 'Life Insurance', property: 'Shop Insurance' }[kind];
    return { label, vehicle: label === 'Vehicle Insurance', insurer };
  }

  // Invoices: name them by the seller and the bill date, e.g. "Ramesh Traders Invoice 12 Aug 2025"
  function sellerAndDate(T, lines) {
    let seller = '';
    for (const l of (lines || []).slice(0, 6)) {
      if (/INVOICE|ORIGINAL|DUPLICATE|TRIPLICATE|COPY|\bGST|\bTAX\b|\bBILL\b|CASH MEMO|PAGE|ESTIMATE|\d{4,}|@|WWW|\.COM/.test(l)) continue;
      const w = l.replace(/[^A-Z&.' ]/g, ' ').replace(/\s+/g, ' ').trim();
      const words = w.split(' ').filter(x => x.length > 1);
      if (words.length >= 1 && words.length <= 6 && letters(w) >= 4 && letters(w) / Math.max(1, l.length) > 0.6) { seller = titleCase(w); break; }
    }
    return { seller };
  }

  // file names like "diansh birth cert.jpg" also count as a hint
  const FILE_HINTS = [
    [/A+DH?A+R|\bUID\b/, 'aadhaar'], [/\bPAN\b/, 'pan'], [/BIRTH/, 'birth'], [/DEATH/, 'death'],
    [/\bDL\b|DRIVING|LICEN[CS]E/, 'dl'], [/PASSPORT/, 'passport'], [/VOTER|\bEPIC\b/, 'voter'],
    [/MARK\s?SHEET|MARKSHEET|RESULT/, 'marksheet'], [/\bRC\b/, 'rc'], [/INSURANCE|POLICY/, 'insurance'],
    [/RATION/, 'ration'], [/CHEQUE|\bCHQ\b/, 'cheque'], [/PASS\s?BOOK/, 'passbook'], [/\bITR\b/, 'itr'],
    [/MARRIAGE/, 'marriage'], [/\bPUC\b|POLLUTION/, 'puc'], [/\bGST\b/, 'gst'], [/ELECTRIC/, 'electricity'],
    [/\bTC\b|TRANSFER CERT/, 'tc'], [/ADMIT/, 'admit'], [/STATEMENT/, 'statement'], [/INVOICE|\bBILL\b/, 'invoice']
  ];

  // ---------- ID numbers ----------
  function aadhaarNo(T) {
    const m = T.match(/(?<![\d])([2-9]\d{3})\s?(\d{4})\s?(\d{4})(?!\s?\d)/);
    return m ? `${m[1]} ${m[2]} ${m[3]}` : '';
  }
  function idNumberFor(key, T) {
    let m;
    switch (key) {
      case 'aadhaar': return aadhaarNo(T);
      case 'pan': m = T.match(/\b([A-Z]{5}\d{4}[A-Z])\b/); return m ? m[1] : '';
      case 'passport':
        m = T.match(/\b([A-Z][0-9]{7})<?\d?IND/) || T.match(/\b([A-PR-WY][1-9]\d{6})\b/);
        return m ? m[1] : '';
      case 'dl':
        m = T.match(/\b([A-Z]{2})[\s\-]?(\d{2})[\s\-]?((?:19|20)\d{2})[\s\-]?(\d{7})\b/);
        if (m) return m[1] + m[2] + m[3] + m[4];
        m = T.match(/\b([A-Z]{2}[\s\-]?\d{2}[\s\-]?\d{11})\b/);
        return m ? m[1].replace(/[\s\-]/g, '') : '';
      case 'voter': m = T.match(/\b([A-Z]{3}\d{7})\b/); return m ? m[1] : '';
      case 'gst': m = T.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/); return m ? m[1] : '';
      case 'rc': case 'puc': return vehicleNo(T);
      case 'insurance':
        m = T.match(/POLICY\s*(?:NO|NUMBER|NUM)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{5,29})/);
        return m ? m[1] : '';
      case 'udyam': m = T.match(/\b(UDYAM-[A-Z]{2}-\d{2}-\d{7})\b/); return m ? m[1] : '';
      case 'premium':
        m = T.match(/POLICY\s*(?:NO|NUMBER|NUM)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{5,29})/);
        return m ? m[1] : '';
      case 'electricity':
        m = T.match(/CONSUMER\s*(?:NO|NUMBER|ID|A\/C)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{4,19})/);
        return m ? m[1] : '';
      case 'recharge': case 'phonebill':
        m = T.match(/(?:MOBILE|PHONE|NUMBER|MSISDN|RECHARGED?\s*(?:FOR|ON)|SERVICE)\D{0,20}?(?:\+?91[\s\-]?)?([6-9]\d{4})\s?(\d{5})\b/) || T.match(/\b([6-9]\d{4})\s?(\d{5})\b/);
        return m ? m[1] + m[2] : '';
      case 'invoice': case 'freight':
        m = T.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/);
        return m ? m[1] : '';
      case 'lr':
        m = T.match(/(?:\bG\.?\s?C\.?\s?NOTE|\bL\.?\s?R\.?|\bG\.?\s?R\.?|\bC\.?\s?N\.?|CONSIGNMENT NOTE|LORRY RECEIPT)\s*(?:NO|NUMBER)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,15})/);
        return m ? m[1] : '';
      default: return '';
    }
  }

  // ---------- dates ----------
  const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  function isoDate(y, mo, d) {
    if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return '';
    return dt.toISOString().slice(0, 10);
  }
  function findDates(T) {
    const out = [];
    let m;
    const r1 = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.]((?:19|20)\d{2})\b/g;
    while ((m = r1.exec(T))) { const iso = isoDate(+m[3], +m[2], +m[1]); if (iso) out.push({ iso, at: m.index }); }
    const r2 = /\b(\d{1,2})(?:ST|ND|RD|TH)?[\s\-\/.]*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[\s\-\/.,]*((?:19|20)\d{2})\b/g;
    while ((m = r2.exec(T))) { const iso = isoDate(+m[3], MON[m[2]], +m[1]); if (iso) out.push({ iso, at: m.index }); }
    return out;
  }
  // The date a recurring document belongs to: the bill month, the receipt date, the statement period
  const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
  const MON_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtMonth = iso => MON_NAME[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4);
  const fmtDay = iso => (+iso.slice(8, 10)) + ' ' + fmtMonth(iso);
  function docDateFor(kind, T) {
    if (!kind) return null;
    if (kind === 'range') {
      const m = T.match(/(?:PERIOD|FROM|STATEMENT FOR)\D{0,25}?(\d{1,2}[\/\-.](?:\d{1,2}|[A-Z]{3})[\/\-.](?:19|20)\d{2})\s*(?:TO|-|–|TILL)\s*(\d{1,2}[\/\-.](?:\d{1,2}|[A-Z]{3})[\/\-.](?:19|20)\d{2})/);
      if (m) {
        const a = findDates(m[1].replace(/[\-.]/g, '/'))[0] || findDates(m[1])[0], b = findDates(m[2].replace(/[\-.]/g, '/'))[0] || findDates(m[2])[0];
        if (a && b) return { iso: a.iso, label: fmtMonth(a.iso) === fmtMonth(b.iso) ? fmtMonth(a.iso) : fmtMonth(a.iso) + ' - ' + fmtMonth(b.iso) };
      }
      return null;
    }
    if (kind === 'month') {
      const m = T.match(new RegExp('(?:BILL(?:ING)?|FOR THE|SALARY|PAY ?SLIP|STATEMENT)\\s*(?:MONTH|PERIOD)?\\s*(?:OF|FOR)?\\s*(?:THE MONTH OF)?\\s*[:\\-]?\\s*(' + MONTHS + ')[A-Z]*[\\s\\-\\/,\']*((?:19|20)?\\d{2})\\b'));
      if (m) {
        const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
        const iso = isoDate(y, MON[m[1]], 1);
        if (iso) return { iso, label: fmtMonth(iso) };
      }
    }
    // a date written next to "date" (bill date, receipt date, transaction date …)
    const d = T.match(new RegExp('(?:BILL|INVOICE|RECEIPT|TRANSACTION|RECHARGE|PAYMENT|ISSUE|LR|DOC(?:UMENT)?)?\\s*DATE[D]?\\s*(?:OF\\s*(?:ISSUE|RECEIPT|PAYMENT|BILL|INVOICE))?\\s*[:\\-]?\\s*(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.](?:19|20)\\d{2}|\\d{1,2}(?:ST|ND|RD|TH)?[\\s\\-]?(?:' + MONTHS + ')[A-Z]*[\\s\\-,]*(?:19|20)\\d{2})'));
    let f = d ? findDates(d[1])[0] : null;
    if (!f) {
      // otherwise the first date that is not a birth, maturity, expiry or due date, and is not in the future
      const soon = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
      f = findDates(T).find(x => x.iso <= soon && !/(BIRTH|DOB|MATURITY|EXPIR|VALID|DUE|COMMENCEMENT|RISK)[^0-9]{0,25}$/.test(T.slice(Math.max(0, x.at - 30), x.at)));
    }
    if (!f) return null;
    return { iso: f.iso, label: kind === 'month' ? fmtMonth(f.iso) : fmtDay(f.iso) };
  }
  const OPERATORS = [[/\bJIO\b/, 'Jio'], [/AIRTEL/, 'Airtel'], [/VODAFONE|\bVI\b/, 'Vi'], [/BSNL/, 'BSNL'], [/TATA PLAY|TATA SKY/, 'Tata Play'], [/DISH ?TV/, 'Dish TV']];
  const operatorOf = T => { for (const [re, n] of OPERATORS) if (re.test(T)) return n; return ''; };

  function expiryFrom(T) {
    const dates = findDates(T);
    if (!dates.length) return '';
    const ctx = /(VALID|VALIDITY|EXPIR|UP\s?TO|TILL|\bTO\b|END|\bNT\b|\bTR\b|DUE|RENEW)/;
    const near = dates.filter(d => ctx.test(T.slice(Math.max(0, d.at - 45), d.at)));
    const pool = near.length ? near : (dates.length >= 2 ? dates : []);
    if (!pool.length) return '';
    return pool.map(d => d.iso).sort().pop();
  }

  // ---------- people's names ----------
  const REL = /\b(FATHER|MOTHER|HUSBAND|GUARDIAN|SPOUSE|WIFE|NOMINEE|PARENT|SON OF|DAUGHTER OF|WIFE OF)\b|\b[SDWC]\s?\/\s?O\b/;
  const ORG = /\b(SCHOOL|COLLEGE|BANK|BRANCH|INSTITUT\w*|HOSPITAL|COMPANY|INSURER|DOCTOR|AGENT|DEALER|VILLAGE|PLACE|REGISTRAR|EMPLOYER|OFFICE|BOARD|UNIVERSITY|PRODUCT|PLAN|SCHEME|FIRM|BUSINESS|SHOP|LOCALITY|DISTRICT|STATE|ISSUING|AUTHORITY|EXAMINATION|COURSE|VEHICLE|MAKER|MODEL|NOMINEE)\b/;
  const NOT_NAME = /\b(GOVERNMENT|GOVT|INDIA|DEPARTMENT|CERTIFICATE|CARD|NUMBER|ADDRESS|MALE|FEMALE|DATE|BIRTH|SIGNATURE|AUTHORITY|REPUBLIC|INCOME|TAX|PERMANENT|ACCOUNT|ELECTION|COMMISSION|IDENTITY|UNIQUE|ISSUE|VALID|OFFICE|STATE|DISTRICT|REGISTRATION|ENROLMENT|DOB|YEAR|AADHAAR|AADHAR|DRIVING|LICENCE|LICENSE|PASSPORT|NATIONALITY|INDIAN|SEX|GENDER|AGE|MOBILE|PHONE|EMAIL|POLICY|PREMIUM|BANK|BRANCH|SCHOOL|ASSAM|PIN|ROAD|WARD|HOUSE|TOWN|CITY|SECTION|ACT|RULE|FORM|TOTAL|MARKS|SUBJECT|RESULT|PASS|CLASS|ROLL|SERIAL|NO)\b/;
  const FILLER = /^(OF|THE|CHILD|CANDIDATE|STUDENT|HOLDER|CARD|CARDHOLDER|APPLICANT|INSURED|PROPOSER|ACCOUNT|ELECTOR|EMPLOYEE|REGISTERED|OWNER|PATIENT|ASSESSEE|DECEASED|CUSTOMER|CONSUMER|BENEFICIARY|BRIDE|BRIDEGROOM|LICENSEE|LICENCEE|IN|FULL|BLOCK|LETTERS|CAPITAL|NAME|NAMES|GIVEN|S|'S)$/;
  const LABEL = /\b(NAME|SURNAME|GIVEN NAMES?|INSURED|PROPOSER|POLICY ?HOLDER|ACCOUNT ?HOLDER|ASSESSEE|PATIENT|CANDIDATE|STUDENT|CARD ?HOLDER)\b/;
  const STOP_AT = /\b(S\s?\/\s?O|D\s?\/\s?O|W\s?\/\s?O|C\s?\/\s?O|DOB|D\.O\.B|DATE|GENDER|SEX|AGE|FATHER|MOTHER|HUSBAND|ADDRESS|ROLL|REG|NO\b|NUMBER|MOBILE|YEAR|YOB|BLOOD|RELATION)/;

  function cleanName(v) {
    let s = String(v || '').toUpperCase().replace(/[^A-Z .'\n]/g, ' ');
    const stop = s.search(STOP_AT);
    if (stop >= 0) s = s.slice(0, stop);
    s = s.replace(/\s+/g, ' ').replace(/^[\s.']+|[\s.']+$/g, '');
    const words = s.split(' ').filter(w => w.replace(/\./g, '').length >= 1);
    while (words.length && FILLER.test(words[0])) words.shift();
    const name = words.join(' ');
    if (words.length < 1 || words.length > 5) return '';
    if (letters(name) < 3 || name.length > 40) return '';
    if (NOT_NAME.test(name)) return '';
    if (words.every(w => w.replace(/\./g, '').length <= 1)) return '';
    return name;
  }

  function nameCandidates(lines, typeKey) {
    const out = [];
    const add = (n, w, how) => { const c = cleanName(n); if (c) out.push({ name: c, weight: w, how }); };

    // passport machine-readable line: P<INDAGARWAL<<DIANSH<<<
    for (const l of lines) {
      const m = l.replace(/\s/g, '').match(/P<IND([A-Z<]+)/);
      if (m) {
        const [sur, given] = m[1].split('<<');
        if (sur && given) add(given.replace(/</g, ' ') + ' ' + sur.replace(/</g, ' '), 12, 'mrz');
      }
    }
    lines.forEach((l, i) => {
      const lab = l.match(LABEL);
      if (!lab) return;
      const before = l.slice(0, lab.index);
      if (REL.test(before + ' ' + lab[0]) || ORG.test(before)) return;
      let rest = l.slice(lab.index + lab[0].length).replace(/^[\s:;|.\-\/]+/, '');
      const firstWords = rest.split(/\s+/).slice(0, 4).join(' ');
      if (REL.test(firstWords.split(/[:|]/)[0]) || ORG.test(firstWords.split(/[:|]/)[0])) return;
      if (rest.includes(':')) rest = rest.split(':').slice(1).join(':');
      let c = cleanName(rest);
      if (!c && lines[i + 1] && !LABEL.test(lines[i + 1]) && !REL.test(lines[i + 1])) c = cleanName(lines[i + 1]);
      if (c) out.push({ name: c, weight: /SURNAME|GIVEN/.test(lab[0]) ? 6 : 10, how: 'label' });
    });
    // Aadhaar & many ID cards: the name sits on the line just above the date of birth
    lines.forEach((l, i) => {
      if (i > 0 && /\b(DOB|D\.O\.B|DATE OF BIRTH|YEAR OF BIRTH|YOB)\b/.test(l) && !REL.test(lines[i - 1])) add(lines[i - 1], 8, 'above-dob');
    });
    // PAN (old style): first name-like line after "INCOME TAX DEPARTMENT"
    if (typeKey === 'pan') {
      const k = lines.findIndex(l => /INCOME\s?TAX|GOVT/.test(l));
      if (k >= 0) for (let j = k + 1; j < Math.min(lines.length, k + 5); j++) { const c = cleanName(lines[j]); if (c) { out.push({ name: c, weight: 7, how: 'pan' }); break; } }
    }
    out.sort((a, b) => b.weight - a.weight);
    return out;
  }

  function relativeLines(lines) {
    const rel = new Set();
    lines.forEach((l, i) => {
      if (REL.test(l)) {
        rel.add(i);
        const after = l.replace(/.*(FATHER|MOTHER|HUSBAND|GUARDIAN|SPOUSE|NOMINEE|S\s?\/\s?O|D\s?\/\s?O|W\s?\/\s?O|C\s?\/\s?O)[^:]*:?/, '');
        if (!cleanName(after)) rel.add(i + 1);
      }
    });
    return rel;
  }

  function memberWords(m) {
    const all = [m.name, m.full_name].concat(String(m.aliases || '').split(','))
      .map(s => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').trim()).filter(Boolean);
    const first = [...new Set(all.map(s => s.split(/\s+/)[0]).filter(w => w.length >= 2))];
    const full = [...new Set(all.filter(s => s.includes(' ')))];
    return { first, full };
  }

  function matchMember(members, lines, cands, fileName) {
    if (!members || !members.length) return null;
    const rel = relativeLines(lines);
    const F = String(fileName || '').toUpperCase().replace(/[^A-Z]+/g, ' ');
    let best = null;
    for (const m of members) {
      const { first, full } = memberWords(m);
      if (!first.length) continue;
      let score = 0;
      for (const c of cands) {
        const cw = c.name.split(' ');
        if (cw.some(w => first.some(f => sameWord(w, f)))) {
          score += c.weight;
          if (full.some(fs => fs.split(' ').every(p => cw.some(w => sameWord(w, p))))) score += 3;
          break;
        }
      }
      let loose = 0;
      lines.forEach((l, i) => {
        if (rel.has(i)) return;
        const lw = l.split(/[^A-Z]+/);
        if (lw.some(w => first.some(f => sameWord(w, f)))) loose += 2;
      });
      score += Math.min(loose, 6);
      if (F && F.split(' ').some(w => first.some(f => sameWord(w, f)))) score += 6;
      if (score > 0 && (!best || score > best.score)) best = { member: m, score };
    }
    return best && best.score >= 2 ? best : null;
  }

  // ---------- file names ----------
  const JUNK_FILE = /^(IMG|IMAGE|DSC|DCIM|PXL|SCAN|SCANNED|CAMSCANNER|DOC|DOCUMENT|NEW DOC|WHATSAPP|SCREENSHOT|PHOTO|PIC|FILE|UNTITLED|COPY|PDF|MERGED|OUTPUT|PRINT|CAPTURE)\b/i;
  function cleanFileName(fn) {
    let s = String(fn || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-.+]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s || JUNK_FILE.test(s) || letters(s) < 3 || /^\W*\d[\d\s]*$/.test(s)) return '';
    s = s.replace(/\b(final|new|copy|scan|scanned|edited|\(\d+\)|\d{6,})\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return letters(s) >= 3 ? titleCase(s).replace(/\bAdhar\b|\bAadhar\b|\bAdhaar\b/g, 'Aadhaar').replace(/\bPan\b/g, 'PAN') : '';
  }

  // ---------- main ----------
  function analyse(text, fileName, members) {
    const raw = String(text || '');
    const lines = raw.toUpperCase().split(/\n+/).map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
    const T = lines.join(' ');
    const FT = String(fileName || '').toUpperCase().replace(/[_\-.]+/g, ' ');
    const readable = letters(raw) >= 25;

    const H = lines.slice(0, 6).join(' ');
    let type = readable ? pickType(T, H, letters(raw)) : null;
    let fromFile = false;
    if (!type) {
      const hint = FILE_HINTS.find(([re]) => re.test(FT));
      if (hint) { type = TYPES.find(t => t.key === hint[1]); fromFile = true; }
    }
    let label = type ? type.label : '';
    let vehicle = type && type.vehicle;
    let insurer = '';
    if (type && type.sub && readable) { const s = type.sub(T); label = s.label; vehicle = vehicle || s.vehicle; insurer = s.insurer || ''; }

    const cands = nameCandidates(lines, type && type.key);
    const hit = matchMember(members, lines, cands, fileName);
    const guessed = !hit && cands.length ? titleCase(cands[0].name) : '';

    const idNumber = type && readable ? idNumberFor(type.key, T) : '';
    const veh = vehicle && readable ? vehicleNo(T) : '';
    const expiry = type && type.expires && readable ? expiryFrom(T) : '';
    let extra = type && type.extra && readable ? type.extra(T, lines) : '';
    const bank = type && type.bank && readable ? bankOf(T) : '';

    const person = hit ? hit.member.name : (guessed ? guessed.split(' ')[0] : '');
    const period = type && type.recurring && readable ? docDateFor(type.recurring, T) : null;
    const operator = type && type.operator && readable ? operatorOf(T) : '';
    let title = '';
    if (label && type.noPerson) {
      // a bill or LR is named after whoever issued it, not the person it was billed to
      const e = extra || {};
      let lbl = label;
      if (type.key === 'invoice' && /ROADWAYS|CARRIER|TRANSPORT|LOGISTIC|CARGO|MOVERS|FREIGHT|TRAVELS/i.test(e.seller || '')) lbl = 'Freight Bill';
      title = [e.seller, lbl, type.key === 'lr' && idNumber ? idNumber : '', period && period.label].filter(Boolean).join(' ');
      label = lbl; extra = '';
    } else if (label) {
      const parts = [person];
      if (bank) parts.push(bank);
      if (insurer && !vehicle) parts.push(insurer);
      if (operator) parts.push(operator);
      if (extra && !type.extraAfter) parts.push(extra);
      parts.push(insurer ? label.replace(/ Policy$/, '') : label);
      if (extra && type.extraAfter) parts.push(extra);
      if (veh) parts.push(veh);
      if (period) parts.push(period.label);
      title = parts.filter(Boolean).join(' ').replace(/\b(\w+) \1\b/gi, '$1');   // "Star Health Health Insurance" → "Star Health Insurance"
    } else {
      const fn = cleanFileName(fileName);
      if (fn) title = person && !fn.toUpperCase().includes(person.toUpperCase()) ? person + ' ' + fn : fn;
      else title = person ? person + ' Document' : '';
    }

    return {
      title,
      docType: label || '',
      typeKey: type ? type.key : '',
      fromFileName: fromFile,
      member: hit ? hit.member : null,
      memberScore: hit ? hit.score : 0,
      guessedName: guessed,             // a name found on the document that is not in your family list yet
      idNumber: idNumber || (veh && type && type.key === 'insurance' ? veh : '') || '',
      expiry,
      docDate: period ? period.iso : '',       // which bill month / receipt date this copy is for
      periodLabel: period ? period.label : '',
      recurring: !!(type && type.recurring),   // a document that comes again and again (bills, receipts)
      readable
    };
  }

  // how alike two texts are, 0 to 1 (used to find the same document scanned twice)
  function similarity(a, b) {
    const set = s => new Set(String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 3));
    const A = set(a), B = set(b);
    if (A.size < 8 || B.size < 8) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
  }

  const DOC_TYPES = [...new Set(TYPES.map(t => t.label).concat(['Vehicle Insurance', 'Health Insurance', 'Life Insurance', 'Shop Insurance', 'Insurance Policy', 'Photo', 'Other']))]
    .filter(l => !['Insurance', 'Certificate'].includes(l)).sort();

  // kinds that come again and again — for these, two copies are only duplicates if they are for the same date
  const RECURRING_TYPES = TYPES.filter(t => t.recurring).map(t => t.label).concat(['Freight Bill']);
  const api = { analyse, similarity, cleanFileName, titleCase, DOC_TYPES, RECURRING_TYPES, _internal: { nameCandidates, expiryFrom, idNumberFor, vehicleNo, classOf } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FVDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
