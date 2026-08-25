"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function UserAvatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string;
  className?: string;
}) {
  return (
    <Avatar className={cn("size-8", className)}>
      {src ? <AvatarImage src={src} alt={name} /> : null}
      <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
