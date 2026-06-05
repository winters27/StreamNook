// The official 7TV wordmark, single-color via currentColor so it picks up the
// surrounding text color (we tint it 7TV blue at the brand spots). Source:
// SevenTV/Extension public/logo.svg. Size it by setting a height class plus
// w-auto, e.g. className="h-5 w-auto text-[#29b6f6]".
export function SevenTVLogo({ className, title = '7TV' }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 109.6 80.9"
      className={className}
      fill="currentColor"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M84.1,22.2l5-8.7,2.7-4.6L86.8.2V0H60.1l5,8.7,5,8.7,2.8,4.8H84.1" />
      <path d="M29,80.6l5-8.7,5-8.7,5-8.7,5-8.7,5-8.7,5-8.7L62.7,22l-5-8.7-5-8.7L49.9.1H7.7l-5,8.7L0,13.4l5,8.7v.2h32l-5,8.7-5,8.7-5,8.7-5,8.7-5,8.7L8.5,72l5,8.7v.2H29" />
      <path d="M70.8,80.6H86.1l5-8.7,5-8.7,5-8.7,5-8.7,3.5-6-5-8.7v-.2H89.2l-5,8.7-5,8.7-.7,1.3-5-8.7-5-8.7-.7-1.3-5,8.7-5,8.7L55,53.1l5,8.7,5,8.7,5,8.7.8,1.4" />
    </svg>
  );
}
