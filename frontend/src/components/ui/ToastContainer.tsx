import { AnimatePresence, motion } from 'framer-motion'
import { useToastStore } from '../../stores/useToastStore'
import Toast from './Toast'

export default function ToastContainer() {
    const toasts = useToastStore((s) => s.toasts)

    return (
        <div className="toast-container" aria-live="polite" role="status">
            <AnimatePresence initial={false}>
                {toasts.map((toast) => (
                    <motion.div
                        key={toast.id}
                        initial={{ opacity: 0, x: 80 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 80 }}
                        transition={{ duration: 0.25, ease: 'easeOut' }}
                    >
                        <Toast toast={toast} />
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    )
}
