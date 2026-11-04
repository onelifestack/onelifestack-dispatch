/**
 * Fake data for {{$random…}} variables (names match Postman's, so collections keep working). Small built-in word
 * lists, no dependency. Values are plausible test data, not real people or valid card numbers.
 */
import { uid } from './types'

const FIRST = ['Aarav', 'Maya', 'Liam', 'Zara', 'Noah', 'Ana', 'Kenji', 'Amara', 'Lucas', 'Priya', 'Omar', 'Elena', 'Kofi', 'Mei', 'Ivan', 'Sara', 'Diego', 'Nia', 'Arjun', 'Leila', 'Tomás', 'Hana', 'Ravi', 'Freya']
const LAST = ['Sharma', 'Okafor', 'García', 'Nguyen', 'Müller', 'Kowalski', 'Haddad', 'Tanaka', 'Silva', 'Johansson', 'Mensah', 'Rossi', 'Patel', 'Kim', 'Novak', 'Dubois', 'Ahmed', 'Costa', 'Ivanova', 'Walker']
const WORDS = ['river', 'lantern', 'orbit', 'maple', 'signal', 'harbor', 'copper', 'meadow', 'pixel', 'summit', 'velvet', 'canyon', 'ember', 'quartz', 'willow', 'beacon', 'cobalt', 'tundra', 'fable', 'nimbus']
const ADJ = ['quick', 'quiet', 'bright', 'gentle', 'brave', 'clever', 'calm', 'eager', 'fancy', 'jolly', 'lively', 'proud', 'silly', 'witty', 'tidy']
const VERBS = ['build', 'carry', 'draw', 'fetch', 'gather', 'jump', 'lift', 'mend', 'paint', 'reach', 'sail', 'shape', 'sort', 'trace', 'weave']
const CITIES = ['Pune', 'Lagos', 'Lisbon', 'Osaka', 'Toronto', 'Nairobi', 'Kraków', 'Medellín', 'Melbourne', 'Tallinn', 'Accra', 'Hanoi', 'Valencia', 'Bergen']
const COUNTRIES: [string, string][] = [['India', 'IN'], ['Nigeria', 'NG'], ['Portugal', 'PT'], ['Japan', 'JP'], ['Canada', 'CA'], ['Kenya', 'KE'], ['Poland', 'PL'], ['Colombia', 'CO'], ['Australia', 'AU'], ['Estonia', 'EE'], ['Ghana', 'GH'], ['Vietnam', 'VN'], ['Spain', 'ES'], ['Norway', 'NO']]
const STREETS = ['Oak', 'Mill', 'Station', 'Harbor', 'Church', 'Park', 'Garden', 'Lake', 'Hill', 'Market']
const SUFFIX = ['Street', 'Road', 'Lane', 'Avenue', 'Way', 'Close']
const COMPANY = ['Labs', 'Works', 'Systems', 'Collective', 'Studio', 'Group', 'Partners', 'Co']
const JOB_LEVEL = ['Senior', 'Lead', 'Junior', 'Principal', 'Staff', 'Associate']
const JOB_AREA = ['Data', 'Platform', 'Product', 'Security', 'Support', 'Design', 'Finance', 'Research']
const JOB_TYPE = ['Engineer', 'Analyst', 'Designer', 'Manager', 'Consultant', 'Specialist', 'Architect']
const DEPARTMENTS = ['Books', 'Garden', 'Toys', 'Music', 'Outdoors', 'Kitchen', 'Health', 'Tools', 'Games', 'Home']
const PRODUCTS = ['Chair', 'Lamp', 'Backpack', 'Kettle', 'Notebook', 'Headphones', 'Bottle', 'Jacket', 'Mug', 'Desk']
const MATERIAL = ['Wooden', 'Steel', 'Cotton', 'Ceramic', 'Bamboo', 'Leather', 'Glass', 'Recycled']
const CURRENCIES = ['USD', 'EUR', 'INR', 'GBP', 'JPY', 'NGN', 'BRL', 'CAD', 'AUD', 'KES']
const LOCALES = ['en', 'en-GB', 'hi', 'fr', 'de', 'es', 'pt-BR', 'ja', 'ko', 'sw', 'pl']
const MIME = ['application/json', 'text/plain', 'image/png', 'image/jpeg', 'application/pdf', 'text/csv', 'application/zip']
const EXT = ['json', 'txt', 'png', 'jpg', 'pdf', 'csv', 'zip']
const TLD = ['com', 'org', 'net', 'io', 'dev', 'test']
const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink', 'brown', 'grey']
const UA = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
]

const int = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min
const pick = <T,>(a: readonly T[]): T => a[int(0, a.length - 1)]
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const hex = (n: number) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('')
const chars = (n: number, set: string) => Array.from({ length: n }, () => set[int(0, set.length - 1)]).join('')
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const sentence = () => { const w = Array.from({ length: int(5, 10) }, () => pick([...WORDS, ...ADJ, ...VERBS])); return `${cap(w.join(' '))}.` }
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()
const domain = () => `${pick(WORDS)}${pick(['', '-', ''])}${pick(WORDS)}.${pick(TLD)}`

export const FAKE: Record<string, () => string> = {
  $guid: () => uid(),
  $uuid: () => uid(),
  $randomUUID: () => uid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(int(0, 1000)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => chars(1, ALNUM),
  $randomHexColor: () => `#${hex(6)}`,
  $randomColor: () => pick(COLORS),
  $randomAbbreviation: () => pick(['API', 'SQL', 'JSON', 'HTTP', 'TCP', 'CSS', 'XML', 'SSL']),
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomNamePrefix: () => pick(['Mr.', 'Ms.', 'Mx.', 'Dr.']),
  $randomUserName: () => `${plain(pick(FIRST))}${pick(['.', '_', ''])}${plain(pick(LAST))}${int(1, 99)}`,
  $randomEmail: () => `${plain(pick(FIRST))}.${plain(pick(LAST))}${int(1, 999)}@example.${pick(['com', 'org', 'net'])}`,
  $randomExampleEmail: () => `${plain(pick(FIRST))}${int(1, 99)}@example.com`,
  $randomPassword: () => chars(15, `${ALNUM}ABCDEFGHJKLMNPQRSTUVWXYZ!@#$%`),
  $randomPhoneNumber: () => `+1-${int(200, 989)}-${int(200, 999)}-${String(int(0, 9999)).padStart(4, '0')}`,
  $randomPhoneNumberExt: () => `+1-${int(200, 989)}-${int(200, 999)}-${String(int(0, 9999)).padStart(4, '0')} x${int(10, 999)}`,
  $randomCity: () => pick(CITIES),
  $randomCountry: () => pick(COUNTRIES)[0],
  $randomCountryCode: () => pick(COUNTRIES)[1],
  $randomStreetName: () => `${pick(STREETS)} ${pick(SUFFIX)}`,
  $randomStreetAddress: () => `${int(1, 9999)} ${pick(STREETS)} ${pick(SUFFIX)}`,
  $randomZipCode: () => String(int(10000, 99999)),
  $randomLatitude: () => (Math.random() * 180 - 90).toFixed(4),
  $randomLongitude: () => (Math.random() * 360 - 180).toFixed(4),
  $randomCompanyName: () => `${cap(pick(WORDS))} ${pick(COMPANY)}`,
  $randomCatchPhrase: () => `${cap(pick(ADJ))} ${pick(WORDS)} for ${pick(WORDS)}s`,
  $randomJobTitle: () => `${pick(JOB_LEVEL)} ${pick(JOB_AREA)} ${pick(JOB_TYPE)}`,
  $randomJobArea: () => pick(JOB_AREA),
  $randomJobType: () => pick(JOB_TYPE),
  $randomDepartment: () => pick(DEPARTMENTS),
  $randomProduct: () => pick(PRODUCTS),
  $randomProductName: () => `${pick(ADJ) === 'quick' ? 'Handy' : cap(pick(ADJ))} ${pick(MATERIAL)} ${pick(PRODUCTS)}`,
  $randomProductMaterial: () => pick(MATERIAL),
  $randomPrice: () => (int(100, 99999) / 100).toFixed(2),
  $randomCurrencyCode: () => pick(CURRENCIES),
  $randomBankAccount: () => String(int(10_000_000, 99_999_999)),
  $randomBankAccountIban: () => `GB${int(10, 99)}TEST${String(int(0, 99_999_999)).padStart(8, '0')}${String(int(0, 999_999)).padStart(6, '0')}`,
  $randomCreditCardMask: () => String(int(1000, 9999)),
  $randomWord: () => pick(WORDS),
  $randomWords: () => Array.from({ length: int(2, 5) }, () => pick(WORDS)).join(' '),
  $randomNoun: () => pick(WORDS),
  $randomVerb: () => pick(VERBS),
  $randomAdjective: () => pick(ADJ),
  $randomLoremWord: () => pick(WORDS),
  $randomLoremWords: () => Array.from({ length: 3 }, () => pick(WORDS)).join(' '),
  $randomLoremSentence: sentence,
  $randomLoremParagraph: () => Array.from({ length: int(3, 5) }, sentence).join(' '),
  $randomLoremSlug: () => Array.from({ length: 3 }, () => pick(WORDS)).join('-'),
  $randomDomainName: domain,
  $randomDomainWord: () => pick(WORDS),
  $randomUrl: () => `https://${domain()}/${pick(WORDS)}`,
  $randomIP: () => `${int(1, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`,
  $randomIPV6: () => Array.from({ length: 8 }, () => hex(4)).join(':'),
  $randomMACAddress: () => Array.from({ length: 6 }, () => hex(2)).join(':'),
  $randomUserAgent: () => pick(UA),
  $randomSemver: () => `${int(0, 9)}.${int(0, 20)}.${int(0, 30)}`,
  $randomLocale: () => pick(LOCALES),
  $randomMimeType: () => pick(MIME),
  $randomFileName: () => `${pick(WORDS)}_${pick(WORDS)}.${pick(EXT)}`,
  $randomFileExt: () => pick(EXT),
  $randomDateFuture: () => daysFromNow(int(1, 365)),
  $randomDatePast: () => daysFromNow(-int(1, 365)),
  $randomDateRecent: () => daysFromNow(-Math.random() * 2),
  $randomWeekday: () => pick(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']),
  $randomMonth: () => pick(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']),
  $randomAvatarImage: () => `https://example.com/avatars/${int(1, 999)}.png`,
}

/** For the help list: every name with one sample value. */
export function fakeSamples(): [string, string][] {
  return Object.entries(FAKE).map(([k, f]) => [k, f()])
}
