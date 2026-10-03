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

  // ---------- document types, most specific first ----------
  // label = how it is named;  expires = has a validity date worth tracking
  const TYPES = [
    { key: 'itr', label: 'ITR', test: T => has(T, /INCOME TAX RETURN|\bITR-?\s?V\b|\bITR ACKNOWLEDGEMENT|INDIAN INCOME TAX RETURN/), extra: assessmentYear, extraAfter: true },
    { key: 'form16', label: 'Form 16', test: T => has(T, /\bFORM\s*(NO\.?\s*)?16\b/) && has(T, /TAX DEDUCTED|\bTDS\b|DEDUCTOR/), extra: assessmentYear, extraAfter: true },
    { key: 'gst', label: 'GST Certificate', test: T => has(T, /REG\s?-?\s?06\b/) || has(T, /REGISTRATION CERTIFICATE.{0,60}GOODS AND SERVICES/) },
    { key: 'udyam', label: 'Udyam Certificate', test: T => has(T, /UDYAM REGISTRATION|UDYAM-[A-Z]{2}-/) },
    { key: 'fssai', label: 'FSSAI Licence', test: T => has(T, /FSSAI|FOOD SAFETY AND STANDARDS/) && has(T, /LICEN|REGISTRATION/), expires: true },
    { key: 'trade', label: 'Trade Licence', test: T => has(T, /TRADE LICEN/), expires: true },
    { key: 'passport', label: 'Passport', test: T => (has(T, /PASSPORT/) && has(T, /REPUBLIC OF INDIA|GOVERNMENT OF INDIA|NATIONALITY/)) || has(T, /P<IND/), expires: true },
    { key: 'death', label: 'Death Certificate', test: T => has(T, /DEATH CERTIFICATE|CERTIFICATE OF DEATH|DATE OF DEATH|NAME OF (THE )?DECEASED/) },
    { key: 'birth', label: 'Birth Certificate', test: T => has(T, /BIRTH CERTIFICATE|CERTIFICATE OF BIRTH|REGISTRATION OF BIRTH|BIRTH REGISTRATION|EXTRACT OF BIRTH/) },
    { key: 'marriage', label: 'Marriage Certificate', test: T => has(T, /MARRIAGE CERTIFICATE|CERTIFICATE OF MARRIAGE|REGISTRATION OF MARRIAGE|MARRIAGE REGISTRATION|SPECIAL MARRIAGE ACT/) },
    { key: 'admit', label: 'Admit Card', test: T => has(T, /ADMIT CARD|HALL TICKET/), extra: classOf },
    { key: 'marksheet', label: 'Marksheet', test: T => has(T, /MARKS?\s?-?SHEET|STATEMENT OF MARKS|MARKS STATEMENT|GRADE\s?SHEET|GRADE CARD|REPORT CARD|PROGRESS REPORT|MARKS OBTAINED/), extra: classOf },
    { key: 'tc', label: 'Transfer Certificate', test: T => has(T, /TRANSFER CERTIFICATE|SCHOOL LEAVING CERTIFICATE|LEAVING CERTIFICATE/) },
    { key: 'migration', label: 'Migration Certificate', test: T => has(T, /MIGRATION CERTIFICATE/) },
    { key: 'passcert', label: 'Pass Certificate', test: T => has(T, /PASS CERTIFICATE|PASSING CERTIFICATE|HAS PASSED|PASSED THE/) && has(T, /EXAMINATION|BOARD|COUNCIL|UNIVERSITY/), extra: classOf },
    { key: 'degree', label: 'Degree Certificate', test: T => has(T, /DEGREE|CONVOCATION|BACHELOR OF|MASTER OF/) && has(T, /UNIVERSITY/), extra: classOf },
    { key: 'puc', label: 'PUC', test: T => has(T, /POLLUTION UNDER CONTROL|\bPUCC?\b|PUC CERTIFICATE/), expires: true, vehicle: true },
    { key: 'insurance', label: 'Insurance', test: T => has(T, /INSURANCE|ASSURANCE/) && has(T, /POLICY|PREMIUM|INSURED/), expires: true, sub: insuranceKind },
    { key: 'rc', label: 'RC', test: T => (has(T, /CERTIFICATE OF REGISTRATION|REGISTRATION CERTIFICATE|\bR\.?C\.?\s?BOOK|REGN\.?\s?(NO|NUMBER)/) && has(T, /CHASSIS|ENGINE|MAKER|VEHICLE|FUEL/)) || (has(T, /CHASSIS/) && has(T, /ENGINE/)), expires: true, vehicle: true },
    { key: 'dl', label: 'Driving Licence', test: T => has(T, /DRIVING\s?LICEN|LICEN[CS]E TO DRIVE|\bDL\s?NO\b/), expires: true },
    { key: 'voter', label: 'Voter ID', test: T => has(T, /ELECTION COMMISSION|ELECTOR|\bEPIC\b/) },
    { key: 'pan', label: 'PAN Card', test: T => has(T, /PERMANENT ACCOUNT NUMBER/) || (has(T, /\b[A-Z]{5}\d{4}[A-Z]\b/) && has(T, /INCOME\s?TAX|GOVT|GOVERNMENT/)) },
    { key: 'aadhaar', label: 'Aadhaar Card', test: T => has(T, /UNIQUE IDENTIFICATION AUTHORITY/) || (has(T, /AADHAA?R|AADHAR|\bUIDAI\b|ENROLMENT NO|MERA AADHAAR/) && !!aadhaarNo(T)) },
    { key: 'ration', label: 'Ration Card', test: T => has(T, /RATION CARD|NATIONAL FOOD SECURITY|PUBLIC DISTRIBUTION SYSTEM|\bNFSA\b/) },
    { key: 'prc', label: 'PRC', test: T => has(T, /PERMANENT RESIDEN(T|CE|TIAL) CERTIFICATE/) },
    { key: 'income', label: 'Income Certificate', test: T => has(T, /INCOME CERTIFICATE/) },
    { key: 'ncl', label: 'Non-Creamy Layer Certificate', test: T => has(T, /NON.?CREAMY/) },
    { key: 'caste', label: 'Caste Certificate', test: T => has(T, /CASTE CERTIFICATE|COMMUNITY CERTIFICATE/) },
    { key: 'domicile', label: 'Domicile Certificate', test: T => has(T, /DOMICILE/) },
    { key: 'residence', label: 'Residence Certificate', test: T => has(T, /RESIDEN(CE|TIAL) CERTIFICATE/) },
    { key: 'vaccine', label: 'Vaccination Certificate', test: T => has(T, /VACCINAT|COWIN|CO-WIN|IMMUNI[SZ]ATION/) },
    { key: 'discharge', label: 'Discharge Summary', test: T => has(T, /DISCHARGE SUMMARY|DISCHARGE CERTIFICATE/) },
    { key: 'medical', label: 'Medical Report', test: T => has(T, /PATHOLOG|LABORATORY|LAB REPORT|HA?EMOGLOBIN|BLOOD SUGAR|PRESCRIPTION|\bRX\b|DIAGNOS|RADIOLOG|X-RAY|ULTRASOUND|\bUSG\b|\bMRI\b|CT SCAN/) },
    { key: 'salary', label: 'Salary Slip', test: T => has(T, /SALARY SLIP|PAY\s?SLIP|SALARY STATEMENT/) },
    { key: 'fd', label: 'FD Receipt', test: T => has(T, /FIXED DEPOSIT|TERM DEPOSIT|\bFDR\b|DEPOSIT RECEIPT/), bank: true },
    { key: 'cheque', label: 'Cancelled Cheque', test: T => has(T, /OR BEARER|OR ORDER/) && has(T, /IFSC|BANK|A\/C/), bank: true },
    { key: 'passbook', label: 'Passbook', test: T => has(T, /PASS\s?BOOK/), bank: true },
    { key: 'statement', label: 'Bank Statement', test: T => has(T, /STATEMENT OF ACCOUNT|ACCOUNT STATEMENT|BANK STATEMENT/), bank: true },
    { key: 'electricity', label: 'Electricity Bill', test: T => has(T, /ELECTRICITY|APDCL|ENERGY BILL|UNITS CONSUMED|POWER DISTRIBUTION/) && has(T, /BILL|CONSUMER/) },
    { key: 'gas', label: 'Gas Connection', test: T => has(T, /\bLPG\b|GAS CONNECTION|INDANE|BHARAT ?GAS|HP ?GAS/) },
    { key: 'phonebill', label: 'Phone Bill', test: T => has(T, /\bJIO\b|AIRTEL|BSNL|VODAFONE/) && has(T, /BILL/) },
    { key: 'saledeed', label: 'Sale Deed', test: T => has(T, /SALE DEED|DEED OF SALE|CONVEYANCE DEED/) },
    { key: 'giftdeed', label: 'Gift Deed', test: T => has(T, /GIFT DEED|DEED OF GIFT/) },
    { key: 'jamabandi', label: 'Jamabandi', test: T => has(T, /JAMABANDI/) },
    { key: 'mutation', label: 'Land Mutation', test: T => has(T, /MUTATION/) && has(T, /LAND|DAG|PATTA/) },
    { key: 'patta', label: 'Land Patta', test: T => has(T, /\bPATTA\b|\bDAG\s?NO/) },
    { key: 'proptax', label: 'Property Tax Receipt', test: T => has(T, /HOLDING TAX|PROPERTY TAX/) },
    { key: 'rent', label: 'Rent Agreement', test: T => has(T, /RENT AGREEMENT|LEASE AGREEMENT|LEASE DEED|LEAVE AND LICEN|TENANCY/), expires: true },
    { key: 'will', label: 'Will', test: T => has(T, /LAST WILL|WILL AND TESTAMENT/) },
    { key: 'poa', label: 'Power of Attorney', test: T => has(T, /POWER OF ATTORNEY/) },
    { key: 'affidavit', label: 'Affidavit', test: T => has(T, /AFFIDAVIT/) },
    { key: 'warranty', label: 'Warranty Card', test: T => has(T, /WARRANTY/), expires: true },
    { key: 'invoice', label: 'Invoice', test: T => has(T, /TAX INVOICE|BILL OF SUPPLY|INVOICE NO|INVOICE NUMBER|CASH MEMO/) },
    { key: 'resume', label: 'Resume', test: T => has(T, /CURRICULUM VITAE|\bRESUME\b/) },
    { key: 'agreement', label: 'Agreement', test: T => has(T, /\bAGREEMENT\b/) },
    { key: 'receipt', label: 'Receipt', test: T => has(T, /\bRECEIPT\b/) }
  ];

  function insuranceKind(T) {
    if (/MOTOR|VEHICLE|CHASSIS|TWO WHEELER|PRIVATE CAR|GOODS CARRYING|REGISTRATION (NO|MARK|NUMBER)/.test(T)) return { label: 'Vehicle Insurance', vehicle: true };
    if (/HEALTH|MEDICLAIM|HOSPITALI[SZ]ATION|FAMILY FLOATER/.test(T)) return { label: 'Health Insurance' };
    if (/\bLIFE\b|\bLIC\b|JEEVAN|TERM PLAN/.test(T)) return { label: 'Life Insurance' };
    if (/FIRE|BURGLARY|SHOP|STOCK|PROPERTY/.test(T)) return { label: 'Shop Insurance' };
    return { label: 'Insurance Policy' };
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

    let type = readable ? TYPES.find(t => t.test(T)) : null;
    let fromFile = false;
    if (!type) {
      const hint = FILE_HINTS.find(([re]) => re.test(FT));
      if (hint) { type = TYPES.find(t => t.key === hint[1]); fromFile = true; }
    }
    let label = type ? type.label : '';
    let vehicle = type && type.vehicle;
    if (type && type.sub && readable) { const s = type.sub(T); label = s.label; vehicle = vehicle || s.vehicle; }

    const cands = nameCandidates(lines, type && type.key);
    const hit = matchMember(members, lines, cands, fileName);
    const guessed = !hit && cands.length ? titleCase(cands[0].name) : '';

    const idNumber = type && readable ? idNumberFor(type.key, T) : '';
    const veh = vehicle && readable ? vehicleNo(T) : '';
    const expiry = type && type.expires && readable ? expiryFrom(T) : '';
    const extra = type && type.extra && readable ? type.extra(T) : '';
    const bank = type && type.bank && readable ? bankOf(T) : '';

    const person = hit ? hit.member.name : (guessed ? guessed.split(' ')[0] : '');
    let title = '';
    if (label) {
      const parts = [person];
      if (bank) parts.push(bank);
      if (extra && !type.extraAfter) parts.push(extra);
      parts.push(label);
      if (extra && type.extraAfter) parts.push(extra);
      if (veh) parts.push(veh);
      title = parts.filter(Boolean).join(' ');
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
    .filter(l => l !== 'Insurance').sort();

  const api = { analyse, similarity, cleanFileName, titleCase, DOC_TYPES, _internal: { nameCandidates, expiryFrom, idNumberFor, vehicleNo, classOf } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FVDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
