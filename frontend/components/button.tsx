import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

const variants = cva('button tf-button', {
  variants: {
    variant: {
      default: 'button-primary',
      outline: 'button-outline',
      ghost: 'text-button',
    },
  },
  defaultVariants: { variant: 'default' },
});

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof variants> & { asChild?: boolean };

export function Button({ asChild = false, variant, className, type = 'button', ...props }: ButtonProps) {
  const Control = asChild ? Slot : 'button';
  return <Control className={variants({ variant, className })} {...(asChild ? {} : { type })} {...props} />;
}
